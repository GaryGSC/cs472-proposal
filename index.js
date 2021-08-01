const { Octokit } = require('@octokit/rest')
const { retry } = require('@octokit/plugin-retry')
const { throttling } = require('@octokit/plugin-throttling')
const consoleLogLevel = require('console-log-level')
const moment = require('moment')
const arff = require('arff')
const fs = require('fs')
const fetch = require('node-fetch')
const cheerio = require('cheerio')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const OctokitWithPlugins = Octokit
  .plugin(throttling) // Gives us hooks for handling errors related to throttling
  .plugin(retry) // All requests sent are now retried up to 3 times for recoverable errors

async function fetchWithRetryAndLogging (url, method = 'GET') {
  const start = Date.now()
  const response = await fetch(url, { method }).catch(() => fetch(url, { method }))
  console.log(`${method} ${url} - ${response.status} in ${Date.now() - start}ms`)
  return response
}

const octokit = new OctokitWithPlugins({
  // We use a personal access token if it's provided in PAT environment variable
  // https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting
  // https://github.com/settings/tokens/new
  ...process.env.PAT && { auth: process.env.PAT },

  // Log what requests we're making
  log: consoleLogLevel({ level: 'info' }),

  // Handle throttling errors
  throttle: {
    onRateLimit: async (retryAfter, options) => {
      octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`)

      // Occasionally we got weird behavior saying we hit our rate limit and that we could try again in 0 seconds
      // When that happens, we're likely to hit the abuse limit. This helps us avoid that.
      if (retryAfter < 10) await sleep(1000)

      // Retry twice after hitting a rate limit error, then give up
      if (options.request.retryCount <= 2) {
        const time = (retryAfter < 60) ? `${retryAfter} seconds` : `${Math.floor(retryAfter / 60)} minutes and ${retryAfter % 60} seconds`
        console.log(`${currentTime()} - Retrying after ${time}!`)
        return true
      }
    },
    onAbuseLimit: (retryAfter, options) => {
      // Does not retry, only logs a warning
      octokit.log.warn(`${currentTime()} - Abuse detected for request ${options.method} ${options.url}`)
    }
  }
})

async function getListOfRepos (query, sort) {
  return octokit.paginate(
    'GET /search/repositories',
    {
      q: query,
      sort: sort,
      mediaType: { previews: ['mercy'] }, // Required to get topics in the response
      page: 1,
      per_page: 100
    },
    (response) => {
      // We don't really care about all the URLs, so we trim down the responses
      return response.data.map(repo => ({
        owner: repo.owner?.login,
        repo: repo.name,
        description: repo.description,
        default_branch: repo.default_branch,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        pushed_at: repo.pushed_at,
        size: repo.size,
        stargazers_count: repo.stargazers_count,
        watchers_count: repo.watchers_count,
        primary_language: repo.language,
        has_issues: repo.has_issues,
        has_projects: repo.has_projects,
        has_downloads: repo.has_downloads,
        has_wiki: repo.has_wiki,
        has_pages: repo.has_pages,
        forks_count: repo.forks_count,
        open_issues_count: repo.open_issues_count,
        license: (repo.license)
          ? (repo.license.spdx_id === 'NOASSERTION')
            ? 'Non-standard'
            : repo.license.spdx_id
          : 'None',
        topics: repo.topics
      }))
    }
  )
}

async function getContributorCounts (listOfRepos) {
  console.log(`${currentTime()} - Getting contributor counts`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('contributor_count')) continue // Already calculated

    const url = `https://www.github.com/${repo.owner}/${repo.repo}`
    const response = await fetchWithRetryAndLogging(url)
    if (response.status !== 200) throw Error(`${currentTime()} - Unexpected status ${response.status} from GET ${url}`)
    const body = await response.text()
    const $ = cheerio.load(body)
    try {
      repo.contributor_count = +$(`a[href="/${repo.owner}/${repo.repo}/graphs/contributors"] > span`).html().trim()
    } catch {
      // If there's only 1 contributor, contributors aren't featured on the sidebar
      repo.contributor_count = 1
    }
  }
}

async function getReadmeLengths (listOfRepos) {
  console.log(`${currentTime()} - Getting readme lengths`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('readme_size')) continue // Already calculated

    try {
      const response = await fetchWithRetryAndLogging(repo.rawReadmeUrl, 'HEAD')
      if (response.status !== 200) throw Error(`${currentTime()} - Unexpected status ${response.status} from HEAD ${repo.rawReadmeUrl}`)
      repo.readme_size = +response.headers.get('content-length')
    } catch {
      repo.readme_size = 0
    }
  }
}

async function getCommunityProfileMetrics (listOfRepos) {
  console.log(`${currentTime()} - Getting community profile metrics`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_code_of_conduct')) continue // Already calculated

    const { data } = await octokit.rest.repos.getCommunityProfileMetrics({
      owner: repo.owner,
      repo: repo.repo
    })
    repo.has_code_of_conduct = !!data.files.code_of_conduct || !!data.files.code_of_conduct_file
    repo.has_contributing = !!data.files.contributing
    repo.has_issue_template = !!data.files.issue_template
    repo.has_pull_request_template = !!data.files.pull_request_template

    if (data.files.readme) {
      const providedReadmeHtmlUrl = data.files.readme.html_url
      repo.rawReadmeUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}${providedReadmeHtmlUrl.split('blob')[1]}`
    } else {
      repo.readme_size = 0
    }
  }
}

async function getLanguages (listOfRepos) {
  console.log(`${currentTime()} - Getting languages`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('languages')) continue // Already calculated

    const { data } = await octokit.rest.repos.listLanguages({
      owner: repo.owner,
      repo: repo.repo
    })
    repo.languages = data
  }
}

async function getDeployments (listOfRepos) {
  console.log(`${currentTime()} - Getting deployments`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_deployments')) continue // Already calculated

    if (repo.environments && repo.environments.length === 0) { // Cannot have deployments without any environments
      repo.has_deployments = false
      continue
    }

    try {
      const response = await octokit.rest.repos.listDeployments({
        owner: repo.owner,
        repo: repo.repo,
        per_page: 1
      })
      repo.has_deployments = response.data.length > 0
    } catch (e) {
      // This errored out with a 502 on RocketChat/Rocket.Chat, which has _thousands_ of deployments
      if (e?.status === 502) repo.has_deployments = true

      // Otherwise, undefined is okay.
    }
  }
}

async function getEnvironments (listOfRepos) {
  console.log(`${currentTime()} - Getting environments`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('environments')) continue // Already calculated

    try {
      repo.environments = await octokit.paginate(
        octokit.rest.repos.getAllEnvironments,
        {
          owner: repo.owner,
          repo: repo.repo,
          per_page: 100
        },
        response => response.data.map(env => env.name)
      )
    } catch {
      repo.environments = []
    }
  }
}

async function getReleases (listOfRepos) {
  console.log(`${currentTime()} - Getting releases`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_releases')) continue // Already calculated

    const releasesUrl = `https://github.com/${repo.owner}/${repo.repo}/releases`
    const response = await fetchWithRetryAndLogging(`${releasesUrl}/latest`, 'HEAD')
    if (response.status !== 200) throw Error(`${currentTime()} - Unexpected status ${response.status} from HEAD ${releasesUrl}/latest`)
    // If there are no releases, we get redirected to an empty list
    // If there are releases, we get redirected to the latest release
    // response.url is the URL we landed on after getting redirected
    repo.has_releases = (response.url !== releasesUrl)
  }
}

async function getWorkflows (listOfRepos) {
  console.log(`${currentTime()} - Getting workflow counts`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('workflows_count')) continue // Already calculated

    const url = `https://github.com/${repo.owner}/${repo.repo}/tree/${repo.default_branch}/.github/workflows`
    const response = await fetchWithRetryAndLogging(url)
    if (response.status === 404) {
      repo.workflows_count = 0
      continue
    }
    if (response.status !== 200) throw Error(`${currentTime()} - Unexpected status ${response.status} from GET ${url}`)
    const body = await response.text()
    const $ = cheerio.load(body)
    const rows = $('div[role="row"]').length
    if (rows) {
      repo.workflows_count = rows - 2 // -2 because our selector wasn't granular enough, so it included the header row and the '...' row
    } else {
      repo.workflows_count = 0
    }
  }
}

async function getIssueLabelsCount (listOfRepos) {
  console.log(`${currentTime()} - Getting issue label counts`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('labels_count')) continue // Already calculated

    const url = `https://github.com/${repo.owner}/${repo.repo}/labels`
    const response = await fetchWithRetryAndLogging(url)
    if (response.status !== 200) throw Error(`${currentTime()} - Unexpected status ${response.status} from GET ${url}`)
    const body = await response.text()
    const $ = cheerio.load(body)
    repo.labels_count = +$('.js-labels-count').text()
  }
}

async function getMilestones (listOfRepos) {
  console.log(`${currentTime()} - Getting milestone counts`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('milestones_count')) continue // Already calculated

    const url = `https://github.com/${repo.owner}/${repo.repo}/milestones`
    const response = await fetchWithRetryAndLogging(url)
    if (response.status === 404) {
      repo.milestones_count = 0
      continue
    }
    if (response.status !== 200) throw Error(`${currentTime()} - Unexpected status ${response.status} from GET ${url}`)
    const body = await response.text()
    const $ = cheerio.load(body)
    const openMilestonesCount = +$(`a.btn-link[href="/${repo.owner}/${repo.repo}/milestones?state=open"]`).text().replace('Open', '').trim()
    const closedMilestonesCount = +$(`a.btn-link[href="/${repo.owner}/${repo.repo}/milestones?state=closed"]`).text().replace('Closed', '').trim()
    repo.milestones_count = openMilestonesCount + closedMilestonesCount
  }
}

async function getSecurityFiles (listOfRepos) {
  console.log(`${currentTime()} - Getting security files`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_security_file')) continue // Already calculated

    // SECURITY.md can be in root directory, /docs, or /.github
    // https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository#about-security-policies
    const directories = ['/', '/docs/', '/.github/']

    // It can also be defined at the organization level, but only at the root of a special .github repository
    // The tricky thing is then knowing what the default branch of that special .github repository is
    // We don't want to call the repository API, so we'll guess that it could be in `main` or `master` at the org level
    // https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file
    const branches = ['master', 'main']

    const urls = [
      ...directories.map(directory => `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.default_branch}${directory}SECURITY.md`),
      ...branches.map(branch => `https://raw.githubusercontent.com/${repo.owner}/.github/${branch}/SECURITY.md`)
    ]
    repo.has_security_file = await doesAnyFileExist(urls)
  }
}

async function getSupportFiles (listOfRepos) {
  console.log(`${currentTime()} - Getting support files`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_support_file')) continue // Already calculated

    // SUPPORT.md can be in root directory, /docs, or /.github
    // https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-support-resources-to-your-project
    const directories = ['/', '/docs/', '/.github/']

    // It can also be defined at the organization level, but only at the root of a special .github repository
    // The tricky thing is then knowing what the default branch of that special .github repository is
    // We don't want to call the repository API, so we'll guess that it could be in `main` or `master` at the org level
    // https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file
    const branches = ['master', 'main']

    const urls = [
      ...directories.map(directory => `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.default_branch}${directory}SUPPORT.md`),
      ...branches.map(branch => `https://raw.githubusercontent.com/${repo.owner}/.github/${branch}/SUPPORT.md`)
    ]
    repo.has_support_file = await doesAnyFileExist(urls)
  }
}

// function splitIntoChunks (arr, chunkSize) {
//   const chunks = []
//   for (let i = 0; i < arr.length; i += chunkSize) {
//     chunks.push(arr.slice(i, i + chunkSize));
//   }
//   return chunks;
// }

async function getFundingFiles (listOfRepos) {
  console.log(`${currentTime()} - Getting funding files`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_funding_file')) continue // Already calculated

    const url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.default_branch}/.github/FUNDING.yml`
    repo.has_funding_file = await doesAnyFileExist([url])
  }
}

async function getCodeowners (listOfRepos) {
  console.log(`${currentTime()} - Getting code owners`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_codeowners')) continue // Already calculated

    // CODEOWNERS can be in root directory, /docs, or /.github
    // https://docs.github.com/en/github/creating-cloning-and-archiving-repositories/creating-a-repository-on-github/about-code-owners#codeowners-file-location
    const directories = ['/', '/docs/', '/.github/']

    const urls = directories.map(directory => `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.default_branch}${directory}CODEOWNERS`)
    repo.has_codeowners = await doesAnyFileExist(urls)
  }
}

async function getChangelog (listOfRepos) {
  console.log(`${currentTime()} - Getting Changelog usage`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_changelog')) continue // Already calculated

    // A best guess - there's no standard here, unless you count https://keepachangelog.com/en/1.0.0/
    const locations = [
      'CHANGELOG.md'
    ]
    const urls = locations.map(location => `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.default_branch}/${location}`)
    repo.has_changelog = await doesAnyFileExist(urls)
  }
}

function doesAnyFileExist (urls) {
  // For each of the possible locations
  return Promise.any(urls.map(url => (
    // Check if file exists there (with a retry)
    fetchWithRetryAndLogging(url, 'HEAD')
      .then(response => {
        // If it was found, we have an answer. The first to _return_ wins
        if (response.status === 200) return true
        // Otherwise, if we _throw_, we wait for the remaining responses
        else throw response.status
      })
  ))).catch(aggregateError => { // Once we have all the responses
    // If we got all 404s, the repo didn't have any of the files
    if (aggregateError.errors.every(e => e === 404)) return false
    // Otherwise something happened during our requests. 429s from rate limiting, maybe?
    else throw aggregateError
  })
}

async function getCodespaces (listOfRepos) {
  console.log(`${currentTime()} - Getting Codespaces usage`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_codespaces')) continue // Already calculated

    // https://docs.github.com/en/codespaces/customizing-your-codespace/configuring-codespaces-for-your-project#devcontainerjson
    const locations = [
      '.devcontainer.json',
      '.devcontainer/devcontainer.json'
    ]
    const urls = locations.map(location => `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.default_branch}/${location}`)
    repo.has_codespaces = await doesAnyFileExist(urls)
  }
}

async function getDiscussions (listOfRepos) {
  console.log(`${currentTime()} - Getting Discussions usage`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('has_discussions')) continue // Already calculated

    const url = `https://github.com/${repo.owner}/${repo.repo}/discussions`
    repo.has_discussions = await doesAnyFileExist([url])
  }
}

async function getDependabot (listOfRepos) {
  console.log(`${currentTime()} - Getting Dependabot usage`)
  for (const repo of listOfRepos) {
    if (repo.hasOwnProperty('uses_dependabot')) continue // Already calculated

    const locations = [
      '.dependabot/config.yml', // Dependabot Preview (old) https://dependabot.com/docs/config-file/
      '.github/dependabot.yml' // GitHub-native (new) https://docs.github.com/en/code-security/supply-chain-security/keeping-your-dependencies-updated-automatically/configuration-options-for-dependency-updates#about-the-dependabotyml-file
    ]
    const urls = locations.map(location => `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${repo.default_branch}/${location}`)
    repo.uses_dependabot = await doesAnyFileExist(urls)
  }
}

function coerceBooleanToYN (boolean) {
  if (boolean === true) return 'y'
  if (boolean === false) return 'n'
  return null
}

async function writeToArffFile (listOfRepos, filename) {
  console.log(`${currentTime()} - Writing to ARFF file`)
  const now = moment()
  const uniqueLanguages = new Set(listOfRepos.map(repo => repo.primary_language))
  const uniqueLicenses = new Set(listOfRepos.map(repo => repo.license))
  const listOfReposInArffFormat = arff.format({
    relation: 'GitHub Community Health',
    attributes: {
      seconds_since_created: {
        name: 'seconds_since_created',
        type: 'numeric'
      },
      seconds_since_updated: {
        name: 'seconds_since_updated',
        type: 'numeric'
      },
      seconds_since_pushed: {
        name: 'seconds_since_pushed',
        type: 'numeric'
      },
      size: {
        name: 'size',
        type: 'numeric'
      },
      stargazers_count: {
        name: 'stargazers_count',
        type: 'numeric'
      },
      watchers_count: {
        name: 'watchers_count',
        type: 'numeric'
      },
      primary_language: {
        name: 'primary_language',
        type: 'enum',
        values: [...uniqueLanguages]
      },
      has_issues: {
        name: 'has_issues',
        type: 'enum',
        values: ['y', 'n']
      },
      has_projects: {
        name: 'has_projects',
        type: 'enum',
        values: ['y', 'n']
      },
      has_downloads: {
        name: 'has_downloads',
        type: 'enum',
        values: ['y', 'n']
      },
      has_wiki: {
        name: 'has_wiki',
        type: 'enum',
        values: ['y', 'n']
      },
      has_pages: {
        name: 'has_pages',
        type: 'enum',
        values: ['y', 'n']
      },
      forks_count: {
        name: 'forks_count',
        type: 'numeric'
      },
      open_issues_count: {
        name: 'open_issues_count',
        type: 'numeric'
      },
      license: {
        name: 'license',
        type: 'enum',
        values: [...uniqueLicenses]
      },
      topics_count: {
        name: 'topics_count',
        type: 'numeric'
      },
      workflows_count: {
        name: 'workflows_count',
        type: 'numeric'
      },
      readme_size: {
        name: 'readme_size',
        type: 'numeric'
      },
      has_code_of_conduct: {
        name: 'has_code_of_conduct',
        type: 'enum',
        values: ['y', 'n']
      },
      has_contributing: {
        name: 'has_contributing',
        type: 'enum',
        values: ['y', 'n']
      },
      has_support_file: {
        name: 'has_support_file',
        type: 'enum',
        values: ['y', 'n']
      },
      has_funding_file: {
        name: 'has_funding_file',
        type: 'enum',
        values: ['y', 'n']
      },
      has_security_file: {
        name: 'has_security_file',
        type: 'enum',
        values: ['y', 'n']
      },
      has_codeowners: {
        name: 'has_codeowners',
        type: 'enum',
        values: ['y', 'n']
      },
      has_changelog: {
        name: 'has_changelog',
        type: 'enum',
        values: ['y', 'n']
      },
      has_codespaces: {
        name: 'has_codespaces',
        type: 'enum',
        values: ['y', 'n']
      },
      has_discussions: {
        name: 'has_discussions',
        type: 'enum',
        values: ['y', 'n']
      },
      uses_dependabot: {
        name: 'uses_dependabot',
        type: 'enum',
        values: ['y', 'n']
      },
      has_issue_template: {
        name: 'has_issue_template',
        type: 'enum',
        values: ['y', 'n']
      },
      has_pull_request_template: {
        name: 'has_pull_request_template',
        type: 'enum',
        values: ['y', 'n']
      },
      languages_count: {
        name: 'languages_count',
        type: 'numeric'
      },
      primary_language_ratio: {
        name: 'primary_language_ratio',
        type: 'numeric'
      },
      has_deployments: {
        name: 'has_deployments',
        type: 'enum',
        values: ['y', 'n']
      },
      environments_count: {
        name: 'environments_count',
        type: 'numeric'
      },
      has_releases: {
        name: 'has_releases',
        type: 'enum',
        values: ['y', 'n']
      },
      labels_count: {
        name: 'labels_count',
        type: 'numeric'
      },
      milestones_count: {
        name: 'milestones_count',
        type: 'numeric'
      },
      default_branch: {
        name: 'default_branch',
        type: 'enum',
        values: ['master', 'main', 'other']
      },
      contributor_count: { // Putting this last for convenience, since we'll be using it as the label
        name: 'contributor_count',
        type: 'numeric'
      }
    },
    data: listOfRepos.map(repo => ({
      seconds_since_created: now.diff(moment(repo.created_at), 'seconds'),
      seconds_since_updated: now.diff(moment(repo.updated_at), 'seconds'),
      seconds_since_pushed: now.diff(moment(repo.pushed_at), 'seconds'),
      size: repo.size,
      stargazers_count: repo.stargazers_count,
      watchers_count: repo.watchers_count,
      primary_language: repo.primary_language,
      has_issues: coerceBooleanToYN(repo.has_issues),
      has_projects: coerceBooleanToYN(repo.has_projects),
      has_downloads: coerceBooleanToYN(repo.has_downloads),
      has_wiki: coerceBooleanToYN(repo.has_wiki),
      has_pages: coerceBooleanToYN(repo.has_pages),
      forks_count: repo.forks_count,
      open_issues_count: repo.open_issues_count,
      license: repo.license,
      topics_count: repo.topics?.length,
      workflows_count: repo.workflows_count,
      readme_size: repo.readme_size,
      has_code_of_conduct: coerceBooleanToYN(repo.has_code_of_conduct),
      has_contributing: coerceBooleanToYN(repo.has_contributing),
      has_support_file: coerceBooleanToYN(repo.has_support_file),
      has_funding_file: coerceBooleanToYN(repo.has_funding_file),
      has_security_file: coerceBooleanToYN(repo.has_security_file),
      has_codeowners: coerceBooleanToYN(repo.has_codeowners),
      has_changelog: coerceBooleanToYN(repo.has_changelog),
      has_codespaces: coerceBooleanToYN(repo.has_codespaces),
      has_discussions: coerceBooleanToYN(repo.has_discussions),
      uses_dependabot: coerceBooleanToYN(repo.uses_dependabot),
      has_issue_template: coerceBooleanToYN(repo.has_issue_template),
      has_pull_request_template: coerceBooleanToYN(repo.has_pull_request_template),
      languages_count: Object.keys(repo.languages).length,
      // Sometimes, the primary language isn't in the list of languages used (???)
      ...repo.languages[repo.primary_language] && {
        primary_language_ratio: repo.languages[repo.primary_language] / Object.values(repo.languages).reduce((a, b) => a + b, 0)
      },
      has_deployments: coerceBooleanToYN(repo.has_deployments),
      environments_count: repo.environments?.length, // TODO: Filter out GitHub pages?
      has_releases: coerceBooleanToYN(repo.has_releases),
      labels_count: repo.labels_count,
      milestones_count: repo.milestones_count,
      default_branch: (repo.default_branch === 'master' || repo.default_branch === 'main') ? repo.default_branch : 'other',
      contributor_count: repo.contributor_count
    }))
  })
  await fs.promises.writeFile(filename, listOfReposInArffFormat)
}

async function writeRawDataToJsonFile (listOfRepos, filename) {
  console.log(`${currentTime()} - Writing to JSON file`)
  await fs.promises.writeFile(filename, JSON.stringify(listOfRepos, null, 2))
}

function removeDuplicateRepos (listOfRepos) {
  return listOfRepos.filter((repo, i, list) => (
    i === list.findIndex(r => (r.owner === repo.owner && r.repo === repo.repo)))
  )
}

async function getDetails (repos) {
  const start = Date.now()

  // We're doing these in sequence to try to play nicely with rate limits
  await getWorkflows(repos)
  await getCommunityProfileMetrics(repos)
  await getReadmeLengths(repos)
  await getLanguages(repos)
  await getSupportFiles(repos)
  await getEnvironments(repos)
  await getFundingFiles(repos)
  await getDeployments(repos)
  await getReleases(repos)
  await getIssueLabelsCount(repos)
  await getMilestones(repos)
  await getSecurityFiles(repos)
  await getCodeowners(repos)
  await getChangelog(repos)
  await getCodespaces(repos)
  await getDiscussions(repos)
  await getDependabot(repos)
  // TODO: Project boards
  // TODO: GOVERNANCE
  // TODO: Checks (Mostly overlaps with workflows, though)
  // TODO: (It doesn't go here, but any derived features?)
  // Any new features will need to be added to the ARFF file
  const end = Date.now()

  const seconds = Math.ceil((end - start) / 1000)
  const time = (seconds < 60) ? `${seconds} seconds` : `${Math.floor(seconds / 60)} minutes and ${seconds % 60} seconds`
  console.log(`${currentTime()} - Finished gathering data for ${repos.length} repos in ${time}!`)

  return repos
}

// TODO: Use an actual logging library like pino to provide this functionality
function currentTime () {
  return new Date().toLocaleTimeString()
}

function shutdown () {
  if (repos) {
    console.log(`${currentTime()} - Shutting down, saving progress`)
    fs.writeFileSync('repos.json', JSON.stringify(repos, null, 2))
  } else {
    console.log(`${currentTime()} - No additional progress to save`)
  }
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGUSR1', shutdown)
process.once('SIGUSR2', shutdown)
process.once('uncaughtException', shutdown)

let repos = null
async function doBatch (query, sort) {
  let savedRepos = []
  try {
    savedRepos = JSON.parse(await fs.promises.readFile('repos.json', { encoding: 'utf-8' }))
    console.log(`${currentTime()} - Found previously-saved data with ${savedRepos.length} rows`)
  } catch {
    console.log(`${currentTime()} - There was no previously-saved data`)
  }

  let newRepos = []
  if (query && sort) {
    console.log(`${currentTime()} - Attempting to get additional rows`)
    // TODO: Figure out how to get this to play nicely with paginating
    // We'd like to do pages 1-10, 11-20, etc. instead of just 1-10 every time we call it
    newRepos = await getListOfRepos('stars:>10', 'updated')
  } else {
    console.log(`${currentTime()} - Fixing up previous rows instead of attempting to get additional rows`)
  }

  repos = removeDuplicateRepos([...savedRepos, ...newRepos])
  console.log(`${currentTime()} - Now have identifiers for ${repos.length} rows ${(query && sort) ? `(${repos.length - savedRepos.length} new)` : ''}`)

  try {
    await getContributorCounts(repos)
    const numBeforeFiltering = repos.length
    repos = repos.filter(repo => repo.contributor_count)
    const numFilteredOut = numBeforeFiltering - repos.length
    if (numFilteredOut) console.log(`${currentTime()} - Filtered out ${numFilteredOut} repos, since they didn't have any contributors (???)`)
    await getDetails(repos)
    await writeToArffFile(repos, 'github.arff')
    if (repos.length > 10000) {
      console.log(`${currentTime()} - Have ${repos.length} repos. Finished!`)
      shutdown()
    }
  } finally {
    if (repos) await writeRawDataToJsonFile(repos, 'repos.json')
  }
}

async function cleanUpBatch (errorToLog = null, minutesToWait = 1) {
  if (errorToLog) console.error(errorToLog)
  console.log(`${currentTime()} - There was an error on the previous batch. Sleeping for ${minutesToWait} minute(s).`)
  await sleep(1000 * 60 * minutesToWait)
  await doBatch() // Clean up any batch stopped mid-process
}

async function main () {
  // We use a personal access token stored in the PAT env var

  // Clean up any batch stopped mid-process
  await doBatch()
    .catch(e => cleanUpBatch(e))
    .catch(e => cleanUpBatch(e))
    .catch(e => cleanUpBatch(e))
    .catch(e => cleanUpBatch(e))
    .catch(e => cleanUpBatch(e))
    .catch(e => cleanUpBatch(e))
    .catch(e => cleanUpBatch(e))
    .catch(e => cleanUpBatch(e))
    .catch(e => cleanUpBatch(e))

  for (let i = 0; i < 100; i++) {
    try {
      await Promise.all([
        doBatch('stars:>10', 'updated'),
        sleep(1000 * 60 * 3) // Wait at least 3 minute between batches
      ])
    } catch (e) {
      await cleanUpBatch(e)
        .catch(e => cleanUpBatch(e))
        .catch(e => cleanUpBatch(e))
        .catch(e => cleanUpBatch(e))
        .catch(e => cleanUpBatch(e))
        .catch(e => cleanUpBatch(e))
        .catch(e => cleanUpBatch(e))
        .catch(e => cleanUpBatch(e))
        .catch(e => cleanUpBatch(e))
        .catch(e => cleanUpBatch(e))
    }
  }

  console.log(`${currentTime()} - Finished! 🎉🎉🎉`)
}

main()

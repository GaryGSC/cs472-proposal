const { Octokit } = require('@octokit/rest')
const { retry } = require('@octokit/plugin-retry')
const { throttling } = require('@octokit/plugin-throttling')
const consoleLogLevel = require('console-log-level')
const moment = require('moment')
const arff = require('arff')
const { promises: fs } = require('fs')
const fetch = require('node-fetch')
const cheerio = require('cheerio')

const OctokitWithPlugins = Octokit
  .plugin(throttling) // Gives us hooks for handling errors related to throttling
  .plugin(retry) // All requests sent are now retried up to 3 times for recoverable errors

const octokit = new OctokitWithPlugins({
  // We use a personal access token if it's provided in PAT environment variable
  // https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting
  // https://github.com/settings/tokens/new
  ...process.env.PAT && { auth: process.env.PAT },

  // Log what requests we're making
  log: consoleLogLevel({ level: 'info' }),

  // Handle throttling errors
  throttle: {
    onRateLimit: (retryAfter, options) => {
      octokit.log.warn(`Request quota exhausted for request ${options.method} ${options.url}`)

      // Retry twice after hitting a rate limit error, then give up
      if (options.request.retryCount <= 2) {
        console.log(`Retrying after ${retryAfter} seconds!`)
        return true
      }
    },
    onAbuseLimit: (retryAfter, options) => {
      // Does not retry, only logs a warning
      octokit.log.warn(`Abuse detected for request ${options.method} ${options.url}`)
    },
  },
})

async function getListOfRepos (desiredCount, pageSize = (desiredCount < 100) ? desiredCount : 100, query = 'stars:>10') {
  let count = 0
  return octokit.paginate(
    'GET /search/repositories',
    {
      q: query,
      sort: 'updated',
      mediaType: { previews: ['mercy'] }, // Required to get topics in the response
      per_page: pageSize
    },
    (response, done) => {
      count += response.data.length
      if (count >= desiredCount) done()
      // We don't really care about all the URLs, so we trim down the responses
      return response.data.map(repo => ({
        owner: repo.owner?.login,
        repo: repo.name,
        description: repo.description,
        fork: repo.fork,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        pushed_at: repo.pushed_at,
        size: repo.size,
        stargazers_count: repo.stargazers_count,
        watchers_count: repo.watchers_count,
        language: repo.language,
        has_issues: repo.has_issues,
        has_projects: repo.has_projects,
        has_downloads: repo.has_downloads,
        has_wiki: repo.has_wiki,
        has_pages: repo.has_pages,
        forks_count: repo.forks_count,
        open_issues_count: repo.open_issues_count,
        license: repo.license?.spdx_id,
        topics: repo.topics,
        default_branch: repo.default_branch
      }))
    }
  )
}

async function getContributorCounts (listOfRepos) {
  // Mimic https://github.com/storybookjs/frontpage/pull/18
  await Promise.all(listOfRepos.map(async repo => {
    const res = await fetch(`https://www.github.com/${repo.owner}/${repo.repo}`)
    const body = await res.text()
    const $ = cheerio.load(body)
    try {
      repo.contributor_count = +$(`a[href="/${repo.owner}/${repo.repo}/graphs/contributors"] > span`).html().trim()
    } catch {
      // If there's only 1 contributor, contributors aren't featured on the sidebar
      repo.contributor_count = 1
    }
  }))
}

async function getReadmeLengths (listOfRepos) {
  for (const repo of listOfRepos) {
    try {
      const { data } = await octokit.rest.repos.getReadme({
        owner: repo.owner,
        repo: repo.repo
      })
      repo.readme_size = data.size
    } catch {
      repo.readme_size = 0
    }
  }
}

async function getCommunityProfileMetrics (listOfRepos) {
  for (const repo of listOfRepos) {
    const { data } = await octokit.rest.repos.getCommunityProfileMetrics({
      owner: repo.owner,
      repo: repo.repo
    })
    repo.has_code_of_conduct = !!data.files.code_of_conduct || !!data.files.code_of_conduct_file
    repo.has_contributing = !!data.files.contributing
    repo.has_issue_template = !!data.files.issue_template
    repo.has_pull_request_template = !!data.files.pull_request_template
  }
}

async function getLanguages (listOfRepos) {
  for (const repo of listOfRepos) {
    const { data } = await octokit.rest.repos.listLanguages({
      owner: repo.owner,
      repo: repo.repo
    })
    repo.languages = data
  }
}

async function getDeployments (listOfRepos) {
  for (const repo of listOfRepos) {
    const response = await octokit.rest.repos.listDeployments({
      owner: repo.owner,
      repo: repo.repo,
      per_page: 1
    })
    repo.has_deployments = response.data.length > 0
  }
}

async function getEnvironments (listOfRepos) {
  for (const repo of listOfRepos) {
    try {
      repo.environments = await octokit.paginate(
        octokit.rest.repos.getAllEnvironments,
        {
          owner: repo.owner,
          repo: repo.repo
        },
        response => response.data.map(env => env.name)
      )
    } catch {
      repo.environments = []
    }
  }
}

async function getReleases (listOfRepos) {
  for (const repo of listOfRepos) {
    const response = await octokit.rest.repos.listReleases({
      owner: repo.owner,
      repo: repo.repo,
      per_page: 1
    })
    repo.has_releases = response.data.length > 0
  }
}

async function getWorkflows (listOfRepos) {
  for (const repo of listOfRepos) {
    repo.workflows = await octokit.paginate(
      octokit.rest.actions.listRepoWorkflows,
      {
        owner: repo.owner,
        repo: repo.repo,
        per_page: 100
      },
      response => response.data.map(workflow => workflow.name)
    )
  }
}

async function getIssueLabels (listOfRepos) {
  for (const repo of listOfRepos) {
    repo.labels = await octokit.paginate(
      octokit.rest.issues.listLabelsForRepo,
      {
        owner: repo.owner,
        repo: repo.repo,
        per_page: 100
      },
      response => response.data.map(label => label.name)
    )
  }
}

async function getMilestones (listOfRepos) {
  for (const repo of listOfRepos) {
    repo.milestones = await octokit.paginate(
      octokit.rest.issues.listMilestones,
      {
        owner: repo.owner,
        repo: repo.repo,
        per_page: 100
      },
      response => response.data.map(milestone => milestone.title)
    )
  }
}

function coerceBooleanToYN (boolean) {
  if (boolean === true) return 'y'
  if (boolean === false) return 'n'
  return null
}

const now = moment()
function getSecondsSince (timestampIsoString) {
  const timestamp = moment(timestampIsoString)
  return now.diff(timestamp, 'seconds')
}

async function writeToArffFile (listOfRepos, filename) {
  const listOfReposInArffFormat = arff.format({
    relation: 'GitHub Community Health',
    attributes: {
      fork: {
        name: 'fork',
        type: 'enum',
        values: ['y', 'n']
      },
      seconds_since_created: {
        name: 'seconds_since_created',
        type: 'number'
      },
      seconds_since_updated: {
        name: 'seconds_since_updated',
        type: 'number'
      },
      seconds_since_pushed: {
        name: 'seconds_since_pushed',
        type: 'number'
      },
      size: {
        name: 'size',
        type: 'number'
      },
      stargazers_count: {
        name: 'stargazers_count',
        type: 'number'
      },
      watchers_count: {
        name: 'watchers_count',
        type: 'number'
      },
      primary_language: {
        name: 'primary_language',
        type: 'string'
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
        type: 'number'
      },
      open_issues_count: {
        name: 'open_issues_count',
        type: 'number'
      },
      license: {
        name: 'license',
        type: 'string'
      },
      topics_count: {
        name: 'topics_count',
        type: 'number'
      },
      workflows_count: {
        name: 'workflows_count',
        type: 'number'
      },
      readme_size: {
        name: 'readme_size',
        type: 'number'
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
        type: 'number'
      },
      primary_language_ratio: {
        name: 'primary_language_ratio',
        type: 'number'
      },
      has_deployments: {
        name: 'has_deployments',
        type: 'enum',
        values: ['y', 'n']
      },
      environments_count: {
        name: 'environments_count',
        type: 'number'
      },
      has_releases: {
        name: 'has_releases',
        type: 'enum',
        values: ['y', 'n']
      },
      labels_count: {
        name: 'labels_count',
        type: 'number'
      },
      milestones_count: {
        name: 'milestones_count',
        type: 'number'
      },
      contributor_count: { // Putting this last for convenience, since we'll be using it as the label
        name: 'contributor_count',
        type: 'number'
      }
    },
    data: listOfRepos.map(repo => ({
      fork: coerceBooleanToYN(repo.fork),
      seconds_since_created: getSecondsSince(repo.created_at),
      seconds_since_updated: getSecondsSince(repo.updated_at),
      seconds_since_pushed: getSecondsSince(repo.pushed_at),
      size: repo.size,
      stargazers_count: repo.stargazers_count,
      watchers_count: repo.watchers_count,
      primary_language: repo.language,
      has_issues: coerceBooleanToYN(repo.has_issues),
      has_projects: coerceBooleanToYN(repo.has_projects),
      has_downloads: coerceBooleanToYN(repo.has_downloads),
      has_wiki: coerceBooleanToYN(repo.has_wiki),
      has_pages: coerceBooleanToYN(repo.has_pages),
      forks_count: repo.forks_count,
      open_issues_count: repo.open_issues_count,
      license: repo.license,
      topics_count: repo.topics?.length,
      workflows_count: repo.workflows?.length,
      readme_size: repo.readme_size,
      has_code_of_conduct: coerceBooleanToYN(repo.has_code_of_conduct),
      has_contributing: coerceBooleanToYN(repo.has_contributing),
      has_issue_template: coerceBooleanToYN(repo.has_issue_template),
      has_pull_request_template: coerceBooleanToYN(repo.has_pull_request_template),
      languages_count: Object.keys(repo.languages).length,
      primary_language_ratio: repo.languages[repo.language] / Object.values(repo.languages).reduce((a, b) => a + b, 0),
      has_deployments: coerceBooleanToYN(repo.has_deployments),
      environments_count: repo.environments?.length,
      has_releases: coerceBooleanToYN(repo.has_releases),
      labels_count: repo.labels?.length,
      milestones_count: repo.milestones?.length,
      contributor_count: repo.contributor_count
    }))
  })
  await fs.writeFile(filename, listOfReposInArffFormat)
}

(async function main () {
  try {
    const start = Date.now()
    let listOfRepos = await getListOfRepos(10)
    await getContributorCounts(listOfRepos)
    // We're doing these in sequence to try to play nicely with rate limits
    await getWorkflows(listOfRepos)
    await getReadmeLengths(listOfRepos)
    await getCommunityProfileMetrics(listOfRepos)
    await getLanguages(listOfRepos)
    await getDeployments(listOfRepos)
    await getEnvironments(listOfRepos)
    await getReleases(listOfRepos)
    await getIssueLabels(listOfRepos)
    await getMilestones(listOfRepos)
    // TODO: More features
    const end = Date.now()
    console.log(`Finished gathering data for ${listOfRepos.length} repos in ${end - start}ms!`)
    await writeToArffFile(listOfRepos, 'github.arff')
  } catch (e) {
    console.error(e)
  }
})()

/*
// Save this to a file:
arff.format({
  relation: 'foo',
  attributes: [
    {
      name: 'date',
      type: 'date'
    },
    {
      name: 'dateWithFormat',
      type: 'date',
      format: 'MM/DD/YY'
    },
    {
      name: 'numeric',
      type: 'numeric'
    },
    {
      name: 'string',
      type: 'string'
    },
    {
      name: 'enumerate',
      type: 'enum',
      values: [
        'foo',
        'bar',
        'baz'
      ]
    },
    {
      name: 'rawStringAtTheEndOfEnumerate',
      type: 'enum',
      values: [
        'rawString'
      ]
    }
  ],
  data: [
    {
      date: new Date(Date.UTC(2014, 11, 16, 19, 42, 1)),
      dateWithFormat: new Date(Date.UTC(2015, 5, 23)),
      numeric: 3.259,
      string: 'can have spaces',
      enumerate: 'bar'
    },
    {
      date: new Date(Date.UTC(2014, 11, 16, 19, 42, 1)),
      numeric: 42
    }
  ]
})

// To get:
@RELATION foo

@ATTRIBUTE date date
@ATTRIBUTE dateWithFormat date "MM/DD/YY"
@ATTRIBUTE numeric numeric
@ATTRIBUTE string string
@ATTRIBUTE enumerate {"foo","bar","baz"}

@DATA
"2014-12-16T19:42:01+00:00","06/23/15",3.259,"can have spaces","bar"
"2014-12-16T19:42:01+00:00",?,42,?,?
*/

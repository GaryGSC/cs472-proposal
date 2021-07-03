# GitHub Community Health
Gary Crye - Interest: 8/10

## Context

GitHub promotes [several community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file#supported-file-types) that supposedly help grow communities. GitHub has built tight integrations around certain files so that repository owners can customize and enhance the experience of users and potential contributors. An easy example of this is how the `README.md` serves as the repository's landing page. A more complicated example is how a GitHub Actions workflow (`.github/workflows/*.yml`) can run automated testing, increasing confidence in new code contributions. We'd like to measure what (if any) impact these and other features have on unique contributor counts.

This information might help us know what features to prioritize in future projects if we were looking for outside contributions from the open source community.

## Data Description

### Some possible input

- [Basic repository details](https://docs.github.com/en/rest/reference/repos#get-a-repository)
    - [README length](https://docs.github.com/en/rest/reference/repos#get-a-repository-readme)
    - Number of topics (like hashtags or filters)
    - Seconds since first push to GitHub
    - Seconds since most recent update
    - [Number of languages used](https://docs.github.com/en/rest/reference/repos#list-repository-languages)
    - [Most common language used](https://docs.github.com/en/rest/reference/repos#list-repository-languages), which might help us control for relative language popularity
- Community Health files
    - [`LICENSE` type](https://docs.github.com/en/rest/reference/repos#get-a-repository), probably using the SPDX identifier
        - In theory, no LICENSE makes contributing nearly impossible. Can we somehow bin licenses from more-permissive to less-permissive to see what impact that makes?
    - `CODE_OF_CONDUCT`
    - `CONTRIBUTING`
    - `FUNDING`
    - Number of `ISSUE_TEMPLATE`s
    - Number of `PULL_REQUEST_TEMPLATE`s
    - `SECURITY`
    - `SUPPORT`
- Other GitHub features
    - `CODEOWNERS`
    - Existence of a `CHANGELOG` or [usage of Releases](https://docs.github.com/en/rest/reference/repos#list-releases)
    - [Usage of Milestones](https://docs.github.com/en/rest/reference/issues#milestones)
    - [CodeSpaces enabled](https://docs.github.com/en/codespaces/setting-up-your-codespace/configuring-codespaces-for-your-project#devcontainerjson)
    - [Wiki enabled](https://docs.github.com/en/rest/reference/repos#get-a-repository)
    - Discussions enabled (`GET https://github.com/{ORG_NAME}/{REPO_NAME}/discussions`)
    - [Number of project boards](https://docs.github.com/en/rest/reference/projects#list-repository-projects)
    - GitHub Actions usage
        - Uses GitHub Actions (`GET https://github.com/{ORG_NAME}/{REPO_NAME}/blob/{DEFAULT_BRANCH_NAME}/.github/workflows`)
        - [Number of GitHub Actions workflows](https://docs.github.com/en/rest/reference/actions#list-repository-workflows)
        - [Number of GitHub Actions workflow runs](https://docs.github.com/en/rest/reference/actions#list-workflow-runs-for-a-repository)
    - Dependabot usage (`GET https://github.com/{ORG_NAME}/{REPO_NAME}/blob/{DEFAULT_BRANCH_NAME}/.github/dependabot.yml`)
    - Uses other GitHub checks integrations, possibly from 3rd party CI tools (Probably measured by looking for the [existence of a check suite on the most recent commit](https://docs.github.com/en/rest/reference/checks#list-check-suites-for-a-git-reference))
- Some stuff that would be harder to figure out
    - Average seconds until first Issue response
    - Average seconds until first Pull Request response
    - Ratio of pull requests merged to pull requests closed without merging
    
### To try to predict
- [Number of code contributors](https://docs.github.com/en/rest/reference/repos#list-repository-contributors), possibly normalized on a log scale ← Main goal
- [Number of forks](https://docs.github.com/en/rest/reference/repos#get-a-repository)
- [Number of watchers](https://docs.github.com/en/rest/reference/repos#get-a-repository)
- [Number of stargazers](https://docs.github.com/en/rest/reference/repos#get-a-repository)
- [Open issues count](https://docs.github.com/en/rest/reference/repos#get-a-repository)
- [Pull request count](https://docs.github.com/en/rest/reference/pulls#list-pull-requests)

### Example

| README length | Number of topics | Seconds since first push to GitHub | Seconds since last update | Number of languages used | Most common language used | LICENSE type | CODE_OF_CONDUCT | CONTRIBUTING | FUNDING | Number of issue templates | Number of pull request templates | SECURITY | SUPPORT | CODEOWNERS | CHANGELOG or Releases | Milestones | CodeSpaces | Wiki | Discussions | Number of GitHub Actions workflows | Dependabot | GitHub Checks | Average seconds until first issue response | Average seconds until first pull request response | Ratio of pull requests merged to pull requests closed without merging | Number of unique contributors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 30139 | 12 | 36010 | 3600 | 5 | JavaScript | Apache-2.0 | True | True | False | 2 | 1 | True | True | True | True | False | False | False | True | 21 | False | True | 3600 | 3600 | 2.5 | 312 |

## Gathering the Data

As linked above, data about these features are available by calling public URLs or by calling corresponding publicly-available endpoints on GitHub's API, but the data will likely require some preprocessing. For example, there's an endpoint to get a repository's README, but not one for its length: we'd need to calculate and possibly normalize that.

There are some caveats. We might be able to use GitHub's newer GraphQL API to simplify some of this data collection, but many of the endpoints above aren't available through the GraphQL interface yet. Also, because we're likely making several API calls for each repository, we're likely to run into rate limits.

To get a list of repositories for our data set, we'd likely call GitHub's repository API in a way similar to [this](https://lornajane.net/posts/2021/measuring-github-community-health). I like the approach from the example of only grabbing repositories with at least 10 stargazers, since that excludes a lot of worthless data.


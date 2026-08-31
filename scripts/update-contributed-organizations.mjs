import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const username = process.env.GITHUB_USER ?? 'savinmikhail';
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const repositoryRoot = process.cwd();
const badgesDirectory = path.join(repositoryRoot, 'assets', 'organizations');
const readmePath = path.join(repositoryRoot, 'README.md');
const detailsPath = path.join(repositoryRoot, 'contributions.md');
const startMarker = '<!-- contributed-orgs:start -->';
const endMarker = '<!-- contributed-orgs:end -->';
const phpEcosystemOrder = [
  'php',
  'symfony',
  'laravel',
  'composer',
  'doctrine',
  'phpstan',
  'php-cs-fixer',
  'vimeo',
  'jetbrains',
  'php-fig',
  'rectorphp',
  'phpmd',
  'deptrac',
  'amphp',
  'infection',
  'opis',
  'psalm',
  'typhoon-php',
  'ergebnis',
];
const featuredOthers = ['docker'];
const hiddenOrganizations = new Set([
  'msavin-mentoring',
  'context-hub',
  'nazarov-community',
  'auth0',
  'amocrm',
]);

if (!token) {
  throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
}

const contributionQuery = `
  query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      createdAt
      contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: 100) {
          repository {
            nameWithOwner
            url
            visibility
            stargazerCount
            owner {
              __typename
              login
              avatarUrl(size: 64)
            }
          }
          contributions(first: 100) {
            nodes {
              occurredAt
              commitCount
            }
          }
        }
        pullRequestContributionsByRepository(maxRepositories: 100) {
          repository {
            nameWithOwner
            url
            visibility
            stargazerCount
            owner {
              __typename
              login
              avatarUrl(size: 64)
            }
          }
          contributions(first: 100) {
            nodes {
              occurredAt
              pullRequest {
                number
                title
                url
                state
                merged
              }
            }
          }
        }
        issueContributionsByRepository(maxRepositories: 100) {
          repository {
            nameWithOwner
            url
            visibility
            stargazerCount
            owner {
              __typename
              login
              avatarUrl(size: 64)
            }
          }
          contributions(first: 100) {
            nodes {
              occurredAt
              issue {
                number
                title
                url
                state
              }
            }
          }
        }
        pullRequestReviewContributionsByRepository(maxRepositories: 100) {
          repository {
            nameWithOwner
            url
            visibility
            stargazerCount
            owner {
              __typename
              login
              avatarUrl(size: 64)
            }
          }
          contributions(first: 100) {
            nodes {
              occurredAt
              pullRequestReview {
                url
                pullRequest {
                  number
                  title
                  url
                  state
                  merged
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function graphql(query, variables) {
  const response = await fetch(`${apiUrl}/graphql`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': `${username}-profile-readme`,
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map(({ message }) => message).join('; '));
  }

  return payload.data;
}

function yearRange(year, createdAt, now) {
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  const creationDate = new Date(createdAt);

  return {
    from: (creationDate > from ? creationDate : from).toISOString(),
    to: (now < to ? now : to).toISOString(),
  };
}

function organizationFor(groups, group) {
  const owner = group.repository.owner;
  if (owner.__typename !== 'Organization' || group.repository.visibility !== 'PUBLIC') {
    return null;
  }

  const key = owner.login.toLowerCase();
  if (!groups.has(key)) {
    groups.set(key, {
      login: owner.login,
      avatarUrl: owner.avatarUrl,
      contributionCount: 0,
      maxRepositoryStars: 0,
      latestAt: '',
      evidence: new Map(),
      truncated: false,
    });
  }

  const organization = groups.get(key);
  organization.maxRepositoryStars = Math.max(
    organization.maxRepositoryStars,
    group.repository.stargazerCount,
  );

  return organization;
}

function addEvidence(organization, evidence) {
  const key = `${evidence.kind}:${evidence.url}`;
  const existing = organization.evidence.get(key);

  if (existing?.kind === 'commits') {
    existing.count += evidence.count;
    if (evidence.occurredAt > existing.occurredAt) {
      existing.occurredAt = evidence.occurredAt;
    }
  } else if (!existing) {
    organization.evidence.set(key, evidence);
  }

  organization.contributionCount += evidence.count ?? 1;
  if (evidence.occurredAt > organization.latestAt) {
    organization.latestAt = evidence.occurredAt;
  }
}

function collectCommits(groups, repositories) {
  for (const group of repositories) {
    const organization = organizationFor(groups, group);
    if (!organization) continue;

    organization.truncated ||= group.contributions.nodes.length === 100;
    for (const contribution of group.contributions.nodes) {
      addEvidence(organization, {
        kind: 'commits',
        url: group.repository.url,
        repository: group.repository.nameWithOwner,
        occurredAt: contribution.occurredAt,
        count: contribution.commitCount,
      });
    }
  }
}

function collectPullRequests(groups, repositories) {
  for (const group of repositories) {
    const organization = organizationFor(groups, group);
    if (!organization) continue;

    organization.truncated ||= group.contributions.nodes.length === 100;
    for (const contribution of group.contributions.nodes) {
      const pullRequest = contribution.pullRequest;
      addEvidence(organization, {
        kind: 'pull-request',
        url: pullRequest.url,
        repository: group.repository.nameWithOwner,
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.merged ? 'merged' : pullRequest.state.toLowerCase(),
        occurredAt: contribution.occurredAt,
      });
    }
  }
}

function collectIssues(groups, repositories) {
  for (const group of repositories) {
    const organization = organizationFor(groups, group);
    if (!organization) continue;

    organization.truncated ||= group.contributions.nodes.length === 100;
    for (const contribution of group.contributions.nodes) {
      const issue = contribution.issue;
      addEvidence(organization, {
        kind: 'issue',
        url: issue.url,
        repository: group.repository.nameWithOwner,
        number: issue.number,
        title: issue.title,
        state: issue.state.toLowerCase(),
        occurredAt: contribution.occurredAt,
      });
    }
  }
}

function collectReviews(groups, repositories) {
  for (const group of repositories) {
    const organization = organizationFor(groups, group);
    if (!organization) continue;

    organization.truncated ||= group.contributions.nodes.length === 100;
    for (const contribution of group.contributions.nodes) {
      const review = contribution.pullRequestReview;
      const pullRequest = review.pullRequest;
      addEvidence(organization, {
        kind: 'review',
        url: review.url ?? pullRequest.url,
        repository: group.repository.nameWithOwner,
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.merged ? 'merged' : pullRequest.state.toLowerCase(),
        occurredAt: contribution.occurredAt,
      });
    }
  }
}

async function collectOrganizations() {
  const currentYear = new Date().getUTCFullYear();
  const initialRange = yearRange(currentYear, '1970-01-01T00:00:00Z', new Date());
  const initialData = await graphql(contributionQuery, {
    login: username,
    ...initialRange,
  });

  if (!initialData.user) {
    throw new Error(`GitHub user ${username} was not found`);
  }

  const createdAt = initialData.user.createdAt;
  const firstYear = new Date(createdAt).getUTCFullYear();
  const organizations = new Map();

  for (let year = firstYear; year <= currentYear; year += 1) {
    const data = year === currentYear
      ? initialData
      : await graphql(contributionQuery, {
          login: username,
          ...yearRange(year, createdAt, new Date()),
        });
    const collection = data.user.contributionsCollection;

    collectCommits(organizations, collection.commitContributionsByRepository);
    collectPullRequests(organizations, collection.pullRequestContributionsByRepository);
    collectIssues(organizations, collection.issueContributionsByRepository);
    collectReviews(organizations, collection.pullRequestReviewContributionsByRepository);
  }

  return [...organizations.values()]
    .map((organization) => ({
      ...organization,
      evidence: [...organization.evidence.values()].sort((left, right) =>
        right.occurredAt.localeCompare(left.occurredAt)),
    }))
    .sort((left, right) =>
      right.contributionCount - left.contributionCount
      || right.latestAt.localeCompare(left.latestAt)
      || left.login.localeCompare(right.login));
}

function organizationsForReadme(organizations) {
  const visible = organizations.filter(
    ({ login }) => !hiddenOrganizations.has(login.toLowerCase()),
  );
  const organizationsByLogin = new Map(
    visible.map((organization) => [organization.login.toLowerCase(), organization]),
  );
  const phpEcosystem = phpEcosystemOrder
    .map((login) => organizationsByLogin.get(login))
    .filter(Boolean);
  const phpLogins = new Set(phpEcosystemOrder);
  const featuredOtherOrder = new Map(
    featuredOthers.map((login, index) => [login.toLowerCase(), index]),
  );
  const others = visible
    .filter(({ login }) => !phpLogins.has(login.toLowerCase()))
    .sort((left, right) => {
      const leftFeatured = featuredOtherOrder.get(left.login.toLowerCase());
      const rightFeatured = featuredOtherOrder.get(right.login.toLowerCase());

      if (leftFeatured !== undefined || rightFeatured !== undefined) {
        if (leftFeatured === undefined) return 1;
        if (rightFeatured === undefined) return -1;
        return leftFeatured - rightFeatured;
      }

      return right.maxRepositoryStars - left.maxRepositoryStars
        || right.latestAt.localeCompare(left.latestAt)
        || right.contributionCount - left.contributionCount
        || left.login.localeCompare(right.login);
    });

  return { phpEcosystem, others };
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeMarkdown(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function slug(value) {
  return value.toLowerCase().replaceAll(/[^a-z0-9-]+/g, '-').replaceAll(/^-|-$/g, '');
}

async function avatarDataUri(url) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': `${username}-profile-readme`,
    },
  });

  if (!response.ok) {
    throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/png';
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)) {
    throw new Error(`Unexpected avatar content type: ${contentType}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

function badgeSvg(organization, avatar) {
  const label = `@${organization.login}`;
  const width = Math.max(112, Math.ceil(52 + label.length * 8.7));
  const clipId = `avatar-${slug(organization.login)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="38" role="img" aria-label="${escapeXml(label)}">
  <title>${escapeXml(label)}</title>
  <rect x="0.5" y="0.5" width="${width - 1}" height="37" rx="9" fill="#0d1117" stroke="#30363d"/>
  <defs><clipPath id="${clipId}"><rect x="6" y="6" width="26" height="26" rx="7"/></clipPath></defs>
  <image x="6" y="6" width="26" height="26" href="${avatar}" clip-path="url(#${clipId})"/>
  <text x="40" y="24.5" fill="#f0f6fc" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="16" font-weight="600">${escapeXml(label)}</text>
</svg>
`;
}

function badgeTarget(organization) {
  const authoredItems = organization.evidence.filter(({ kind }) =>
    kind === 'pull-request' || kind === 'issue');

  return authoredItems.length === 1
    ? authoredItems[0].url
    : `./contributions.md#${slug(organization.login)}`;
}

function readmeBadges(organizations) {
  return organizations.map((organization) => {
    const badgePath = `./assets/organizations/${slug(organization.login)}.svg`;
    return `<a href="${badgeTarget(organization)}"><img src="${badgePath}" alt="@${escapeXml(organization.login)}" height="38"></a>`;
  }).join('\n');
}

function evidenceLabel(evidence) {
  if (evidence.kind === 'commits') {
    return `${evidence.count} commit${evidence.count === 1 ? '' : 's'} to ${evidence.repository}`;
  }

  const type = evidence.kind === 'pull-request'
    ? 'PR'
    : evidence.kind === 'issue'
      ? 'Issue'
      : 'Review';
  return `${type} ${evidence.repository}#${evidence.number}: ${escapeMarkdown(evidence.title)}`;
}

function detailsMarkdown(organizations) {
  const sections = organizations.map((organization) => {
    const evidence = organization.evidence.map((item) => {
      const state = item.state ? ` — ${item.state}` : '';
      return `- [${evidenceLabel(item)}](${item.url})${state} · ${item.occurredAt.slice(0, 10)}`;
    });

    if (organization.truncated) {
      evidence.push('- Some contribution details were omitted because GitHub returned more than 100 entries for a repository and contribution type.');
    }

    return `## ${organization.login}\n\n${evidence.join('\n')}`;
  });

  return `# Public organization contributions\n\nThis page is generated from GitHub's public contribution data for [@${username}](https://github.com/${username}). Opened issues and pull requests are included even when they are not merged, matching GitHub's contribution model.\n\n${sections.join('\n\n')}\n`;
}

async function writeIfChanged(filePath, content) {
  let existing = null;
  try {
    existing = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (existing !== content) {
    await writeFile(filePath, content);
  }
}

async function updateReadme({ phpEcosystem, others }) {
  const readme = await readFile(readmePath, 'utf8');
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);

  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md must contain ${startMarker} and ${endMarker}`);
  }

  const generated = [
    startMarker,
    '**PHP ecosystem**',
    '',
    readmeBadges(phpEcosystem),
    '',
    '**Others**',
    '',
    readmeBadges(others),
    endMarker,
  ].join('\n');
  const updated = `${readme.slice(0, start)}${generated}${readme.slice(end + endMarker.length)}`;
  await writeIfChanged(readmePath, updated);
}

async function updateBadges(organizations) {
  await mkdir(badgesDirectory, { recursive: true });
  const expectedFiles = new Set();

  for (const organization of organizations) {
    const filename = `${slug(organization.login)}.svg`;
    expectedFiles.add(filename);
    const avatar = await avatarDataUri(organization.avatarUrl);
    await writeIfChanged(path.join(badgesDirectory, filename), badgeSvg(organization, avatar));
  }

  for (const filename of await readdir(badgesDirectory)) {
    if (filename.endsWith('.svg') && !expectedFiles.has(filename)) {
      await unlink(path.join(badgesDirectory, filename));
    }
  }
}

const organizations = await collectOrganizations();
const readmeOrganizations = organizationsForReadme(organizations);
const visibleOrganizations = [
  ...readmeOrganizations.phpEcosystem,
  ...readmeOrganizations.others,
];
await updateBadges(visibleOrganizations);
await updateReadme(readmeOrganizations);
await writeIfChanged(detailsPath, detailsMarkdown(organizations));

console.log(
  `Updated ${visibleOrganizations.length} visible organization badges `
  + `from ${organizations.length} public organizations for @${username}.`,
);

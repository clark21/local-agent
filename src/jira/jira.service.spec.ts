import {
  DEFAULT_JIRA_JQL,
  JiraService,
  adfToText,
  parseJiraQuery,
} from './jira.service';

describe('parseJiraQuery', () => {
  it.each([
    ['', { kind: 'jql', jql: DEFAULT_JIRA_JQL }],
    ['api-123', { kind: 'issue', key: 'API-123' }],
    [
      'API',
      { kind: 'jql', jql: 'project = API AND statusCategory != Done ORDER BY updated DESC' },
    ],
    ['project = API AND status = "To Do"', { kind: 'jql', jql: 'project = API AND status = "To Do"' }],
    ['assignee is EMPTY', { kind: 'jql', jql: 'assignee is EMPTY' }],
    ['login "fails"', { kind: 'jql', jql: 'text ~ "login \\"fails\\"" ORDER BY updated DESC' }],
  ])('parses %j', (input, expected) => {
    expect(parseJiraQuery(input)).toEqual(expected);
  });
});

describe('adfToText', () => {
  it('renders common Atlassian Document Format nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goal' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ping ' },
            { type: 'mention', attrs: { text: '@Ana' } },
            { type: 'hardBreak' },
            { type: 'inlineCard', attrs: { url: 'https://example.com' } },
          ],
        },
        {
          type: 'orderedList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'x()' }] },
      ],
    };

    expect(adfToText(doc)).toBe(
      '## Goal\n\nPing @Ana\nhttps://example.com\n\n1. one\n2. two\n\n```ts\nx()\n```',
    );
  });

  it('passes plain strings through', () => {
    expect(adfToText('plain description')).toBe('plain description');
    expect(adfToText(null)).toBe('');
  });
});

describe('JiraService', () => {
  const config = {
    jira: { baseUrl: 'https://acme.atlassian.net', email: 'me@acme.test', apiToken: 'secret' },
  };
  let fetchMock: jest.SpyInstance;

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('searches with the enhanced JQL endpoint and basic auth', async () => {
    respond(200, {
      issues: [
        {
          key: 'API-1',
          fields: {
            summary: 'Fix login',
            status: { name: 'To Do' },
            issuetype: { name: 'Bug' },
            assignee: { displayName: 'Ana' },
          },
        },
      ],
      nextPageToken: 'page-2',
      isLast: false,
    });
    const service = new JiraService(config as never);

    const page = await service.search('project = API', undefined, 5);

    expect(page).toEqual({
      issues: [{ key: 'API-1', summary: 'Fix login', status: 'To Do', type: 'Bug', assignee: 'Ana' }],
      nextPageToken: 'page-2',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('me@acme.test:secret').toString('base64')}`,
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      jql: 'project = API',
      maxResults: 5,
    });
  });

  it('stops paging on the last page', async () => {
    respond(200, { issues: [], nextPageToken: 'ignored', isLast: true });
    const service = new JiraService(config as never);

    await expect(service.search('project = API', 'page-2')).resolves.toEqual({
      issues: [],
      nextPageToken: undefined,
    });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string))
      .toMatchObject({ nextPageToken: 'page-2' });
  });

  it('loads an issue with description, links, and the latest comments', async () => {
    respond(200, {
      key: 'API-7',
      fields: {
        summary: 'Add export',
        status: { name: 'In Progress' },
        issuetype: { name: 'Story' },
        priority: { name: 'High' },
        reporter: { displayName: 'Ben' },
        labels: ['backend'],
        parent: { key: 'API-1', fields: { summary: 'Epic' } },
        subtasks: [{ key: 'API-8', fields: { summary: 'CSV' } }],
        issuelinks: [
          { type: { outward: 'blocks' }, outwardIssue: { key: 'WEB-2', fields: { summary: 'UI' } } },
        ],
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Export rows.' }] }] },
        comment: {
          comments: Array.from({ length: 7 }, (_, index) => ({
            author: { displayName: `User ${index}` },
            created: `2026-10-0${index + 1}T10:00:00.000+0000`,
            body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `c${index}` }] }] },
          })),
        },
      },
    });
    const service = new JiraService(config as never);

    const issue = await service.getIssue('API-7');

    expect(issue).toMatchObject({
      key: 'API-7',
      url: 'https://acme.atlassian.net/browse/API-7',
      priority: 'High',
      assignee: undefined,
      labels: ['backend'],
      parent: 'API-1 (Epic)',
      subtasks: ['API-8 (CSV)'],
      links: ['blocks WEB-2 (UI)'],
      description: 'Export rows.',
    });
    expect(issue.comments.map((comment) => comment.body)).toEqual(['c2', 'c3', 'c4', 'c5', 'c6']);
    expect(issue.comments[0]).toEqual({ author: 'User 2', created: '2026-10-03', body: 'c2' });
    expect(service.describe(issue)).toContain('Assignee: Unassigned');
  });

  it('builds an agent prompt that fits the task limit', () => {
    const service = new JiraService(config as never);
    const issue = {
      key: 'API-7',
      summary: 'Add export',
      status: 'To Do',
      url: 'https://acme.atlassian.net/browse/API-7',
      labels: [],
      subtasks: [],
      links: [],
      description: 'x'.repeat(5_000),
      comments: [],
    };

    const prompt = service.prompt(issue, 'plan', 1_500);

    expect(prompt.length).toBeLessThanOrEqual(1_500);
    expect(prompt).toContain('Jira ticket API-7: Add export');
    expect(prompt).toContain('[truncated; open https://acme.atlassian.net/browse/API-7');
    expect(prompt).toContain('Do not modify any files yet.');
  });

  it('explains Jira errors', async () => {
    respond(401, {});
    respond(400, { errorMessages: ["Field 'nope' does not exist"], errors: {} });
    const service = new JiraService(config as never);

    await expect(service.search('x')).rejects.toThrow('Jira rejected the credentials (401)');
    await expect(service.search('nope = 1')).rejects.toThrow(
      "Jira request failed (400): Field 'nope' does not exist",
    );
  });

  it('reports when Jira is not configured', async () => {
    const service = new JiraService({} as never);

    expect(service.enabled).toBe(false);
    await expect(service.search('x')).rejects.toThrow('Jira is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

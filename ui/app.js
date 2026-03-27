// ================================================================
// Command Center — Application Logic
// ================================================================

// ── State ────────────────────────────────────────────────────────

const state = {
  projects: [],
  selectedProjectId: null,
  activeTab: 'team',
  teamData: [],
  eventSource: null,
};

// ── DOM References ───────────────────────────────────────────────

const dom = {
  projectList:        document.getElementById('projectList'),
  tabNav:             document.getElementById('tabNav'),
  selectedProjectLabel: document.getElementById('selectedProjectLabel'),
  emptyState:         document.getElementById('emptyState'),
  teamGrid:           document.getElementById('teamGrid'),
  teamCount:          document.getElementById('teamCount'),
  boardColumns:       document.getElementById('boardColumns'),
  boardLastUpdated:   document.getElementById('boardLastUpdated'),
  opsGrid:            document.getElementById('opsGrid'),
  opsLastUpdated:     document.getElementById('opsLastUpdated'),
  captainMessage:     document.getElementById('captainMessage'),
  navTabs:            document.querySelectorAll('.cc-nav-tab'),
};

// ── Utility Functions ────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function timeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── API Layer ────────────────────────────────────────────────────

/**
 * Make an API call through the gateway proxy.
 * All project-scoped calls go through /api/proxy and include
 * the X-Project-Id header for routing.
 */
async function apiCall(path) {
  const headers = {};
  if (state.selectedProjectId) {
    headers['X-Project-Id'] = state.selectedProjectId;
  }
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch the project registry from the gateway.
 */
async function fetchRegistry() {
  const res = await fetch('/api/registry');
  if (!res.ok) {
    throw new Error(`Failed to fetch registry: HTTP ${res.status}`);
  }
  return res.json();
}

// ── Project List ─────────────────────────────────────────────────

async function loadProjects() {
  try {
    const data = await fetchRegistry();
    state.projects = data.projects || data || [];
    renderProjectList();

    // Auto-select first project
    if (state.projects.length > 0 && !state.selectedProjectId) {
      selectProject(state.projects[0].id);
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
    dom.projectList.innerHTML = `
      <div class="cc-loading">Unable to reach gateway. Retrying...</div>
    `;
    // Retry after 5s
    setTimeout(loadProjects, 5000);
  }
}

function renderProjectList() {
  if (state.projects.length === 0) {
    dom.projectList.innerHTML = `
      <div class="cc-loading">No projects registered.</div>
    `;
    return;
  }

  dom.projectList.innerHTML = state.projects.map(project => {
    const isActive = project.id === state.selectedProjectId;
    const statusClass = project.status || 'running';
    return `
      <div class="cc-project-card ${isActive ? 'active' : ''}"
           data-project-id="${escapeHtml(project.id)}">
        <span class="cc-project-dot ${escapeHtml(statusClass)}"></span>
        <span class="cc-project-name">${escapeHtml(project.name)}</span>
        <span class="cc-project-port">${project.port || ''}</span>
      </div>
    `;
  }).join('');
}

function selectProject(projectId) {
  state.selectedProjectId = projectId;

  // Update project list highlights
  renderProjectList();

  // Find the project info
  const project = state.projects.find(p => p.id === projectId);

  // Show tab nav with project name
  dom.tabNav.style.display = 'flex';
  dom.selectedProjectLabel.textContent = project ? project.name : projectId;

  // Hide empty state
  dom.emptyState.style.display = 'none';

  // Reconnect SSE for new project
  connectSSE();

  // Load the active tab
  showTab(state.activeTab);
}

// ── Tab Navigation ───────────────────────────────────────────────

function showTab(tabName) {
  state.activeTab = tabName;

  // Update nav tab highlights
  dom.navTabs.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Hide all tab content
  document.querySelectorAll('.cc-tab-content').forEach(el => {
    el.style.display = 'none';
  });

  // Show selected tab
  const tabEl = document.getElementById(`tab-${tabName}`);
  if (tabEl) {
    tabEl.style.display = 'block';
  }

  // Load tab data
  loadTabData(tabName);
}

async function loadTabData(tabName) {
  switch (tabName) {
    case 'team':
      await loadTeamData();
      break;
    case 'board':
      await loadBoardData();
      break;
    case 'ops':
      await loadOpsData();
      break;
    case 'threads':
      await loadThreadsData();
      break;
    case 'metrics':
      await loadMetricsData();
      break;
  }
}

// ── Team Tab ─────────────────────────────────────────────────────

async function loadTeamData() {
  if (!state.selectedProjectId) return;

  dom.teamGrid.innerHTML = `<div class="cc-loading">Loading team...</div>`;

  try {
    const data = await apiCall('/api/assistants');
    const assistants = data.assistants || data || [];
    state.teamData = assistants;
    renderTeam();
  } catch (err) {
    console.error('Failed to load team:', err);
    // Show placeholder team data as fallback
    state.teamData = getFallbackTeam();
    renderTeam();
  }
}

/**
 * Returns fallback team data when the API is unavailable.
 * This lets us demonstrate the UI before the backend is wired up.
 */
function getFallbackTeam() {
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  const name = project ? project.name : state.selectedProjectId;
  return [
    {
      id: 'captain',
      name: 'Captain',
      type: 'agent',
      status: 'offline',
      description: `Project lead agent for ${name}`,
    },
  ];
}

function renderTeam() {
  const members = state.teamData;

  if (members.length === 0) {
    dom.teamGrid.innerHTML = `
      <div class="cc-team-empty">
        <p>No team members found.</p>
        <p style="font-size: 12px; color: var(--cc-text-faint);">
          Agents will appear here once the project instance is running.
        </p>
      </div>
    `;
    dom.teamCount.textContent = '';
    return;
  }

  dom.teamCount.textContent = `${members.length} member${members.length !== 1 ? 's' : ''}`;
  dom.teamGrid.innerHTML = members.map(member => renderTeamCard(member)).join('');
}

function renderTeamCard(member) {
  const isAgent = member.type === 'agent' || member.type === 'assistant' || member.type === 'personal' || member.type === 'coding' || member.type === 'captain';
  const initial = (member.name || member.id || '?').charAt(0).toUpperCase();
  const avatarClass = isAgent ? 'cc-avatar-agent' : 'cc-avatar-user';
  const displayName = member.name || member.id;
  const typeLabel = isAgent ? 'AI Agent' : 'Human';
  const status = member.status || 'offline';
  const statusClass = status === 'online' || status === 'active' ? 'cc-status-online' : 'cc-status-offline';
  const statusLabel = status === 'online' || status === 'active' ? 'Online' : 'Offline';

  return `
    <div class="cc-team-card">
      <div class="cc-team-card-header">
        <div class="cc-avatar ${avatarClass}">${escapeHtml(initial)}</div>
        <div>
          <div class="cc-team-card-name">${escapeHtml(displayName)}</div>
          <div class="cc-team-card-type">${escapeHtml(typeLabel)}</div>
        </div>
      </div>
      ${member.description ? `<div class="cc-team-detail" style="margin-bottom: 4px;">${escapeHtml(member.description)}</div>` : ''}
      <div class="cc-team-card-status ${statusClass}">
        <span class="cc-status-dot"></span>
        ${escapeHtml(statusLabel)}
      </div>
      <div class="cc-team-card-details">
        ${member.threadCount != null ? `
          <div class="cc-team-detail">
            <span class="cc-team-detail-label">Threads:</span> ${member.threadCount}
          </div>
        ` : ''}
        ${member.lastActive ? `
          <div class="cc-team-detail">
            <span class="cc-team-detail-label">Last active:</span> ${timeAgo(member.lastActive)}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ── Board Tab ───────────────────────────────────────────────

const BOARD_COLUMNS = ['Backlog', 'In Progress', 'In Review', 'Done'];

// Task-based board column mapping (task states -> board columns)
const TASK_STATE_TO_COLUMN = {
  created: 'Backlog',
  assigned: 'In Progress',
  in_progress: 'In Progress',
  blocked: 'In Progress',
  in_review: 'In Review',
  qa: 'In Review',
  done: 'Done',
  cancelled: 'Done',
};

async function loadBoardData() {
  if (!state.selectedProjectId) return;

  dom.boardColumns.innerHTML = `<div class="cc-loading">Loading board...</div>`;

  try {
    // Try tasks first — if tasks exist, render task-based board
    const taskData = await apiCall('/api/tasks');
    const tasks = taskData.tasks || [];

    if (tasks.length > 0) {
      renderBoardFromTasks(tasks);
      dom.boardLastUpdated.textContent = `Updated ${timeAgo(new Date().toISOString())}`;
      return;
    }
  } catch {
    // Tasks endpoint failed — fall through to GitHub issues
  }

  try {
    // Fallback: raw GitHub issues board
    const data = await apiCall('/api/board');
    if (data.columns) {
      renderBoardFromColumns(data.columns);
      dom.boardLastUpdated.textContent = data.lastUpdated ? `Updated ${timeAgo(data.lastUpdated)}` : '';
    } else {
      const issues = data.issues || data || [];
      renderBoard(issues);
      dom.boardLastUpdated.textContent = `Updated ${timeAgo(new Date().toISOString())}`;
    }
  } catch (err) {
    console.error('Failed to load board:', err);
    renderBoard([]);
    dom.boardLastUpdated.textContent = 'Unable to load';
  }
}

function renderBoardFromTasks(tasks) {
  const columns = {};
  BOARD_COLUMNS.forEach(col => columns[col] = []);

  tasks.forEach(task => {
    const col = TASK_STATE_TO_COLUMN[task.state] || 'Backlog';
    if (columns[col]) {
      columns[col].push(task);
    } else {
      columns['Backlog'].push(task);
    }
  });

  dom.boardColumns.innerHTML = BOARD_COLUMNS.map(colName => {
    const cards = columns[colName];
    const cardHtml = cards.length === 0
      ? `<div class="cc-board-empty">No tasks</div>`
      : cards.map(task => renderTaskCard(task)).join('');

    return `
      <div class="cc-board-column">
        <div class="cc-board-column-header">
          <span class="cc-board-column-title">${escapeHtml(colName)}</span>
          <span class="cc-board-column-count">${cards.length}</span>
        </div>
        <div class="cc-board-card-list">
          ${cardHtml}
        </div>
      </div>
    `;
  }).join('');
}

function taskStateColor(taskState) {
  const colors = {
    created: '#8b949e',
    assigned: '#d29922',
    in_progress: '#d29922',
    blocked: '#f85149',
    in_review: '#a371f7',
    qa: '#a371f7',
    done: '#3fb950',
    cancelled: '#8b949e',
  };
  return colors[taskState] || '#8b949e';
}

function taskPriorityIndicator(priority) {
  const indicators = {
    critical: '<span class="cc-task-priority cc-priority-critical" title="Critical">!!!</span>',
    high: '<span class="cc-task-priority cc-priority-high" title="High">!!</span>',
    normal: '',
    low: '<span class="cc-task-priority cc-priority-low" title="Low">-</span>',
  };
  return indicators[priority] || '';
}

function renderTaskCard(task) {
  const stateColor = taskStateColor(task.state);
  const stateLabel = (task.state || '').replace(/_/g, ' ');
  const priorityHtml = taskPriorityIndicator(task.priority);
  const assigneeHtml = task.assignee
    ? `<span class="cc-board-assignees">${escapeHtml(task.assignee)}</span>`
    : '';
  const ghLinkHtml = task.githubIssue
    ? `<span class="cc-task-gh-link" title="GitHub issue #${task.githubIssue}">#${task.githubIssue}</span>`
    : '';
  const labelsHtml = (task.labels || []).map(label =>
    `<span class="cc-board-label">${escapeHtml(label)}</span>`
  ).join('');

  return `
    <div class="cc-board-card">
      <div class="cc-board-card-top">
        <span class="cc-board-card-number">${escapeHtml(task.id)}</span>
        ${priorityHtml}
        ${ghLinkHtml}
      </div>
      <div class="cc-board-card-title">${escapeHtml(task.title)}</div>
      <div class="cc-board-card-state" style="color: ${stateColor}; border-color: ${stateColor};">
        ${escapeHtml(stateLabel)}
      </div>
      ${labelsHtml ? `<div class="cc-board-card-labels">${labelsHtml}</div>` : ''}
      ${assigneeHtml ? `<div class="cc-board-card-footer">${assigneeHtml}</div>` : ''}
    </div>
  `;
}

function renderBoardFromColumns(columns) {
  dom.boardColumns.innerHTML = columns.map(col => {
    const cards = col.issues || [];
    const cardHtml = cards.length === 0
      ? `<div class="cc-board-empty">No issues</div>`
      : cards.map(issue => renderBoardCard(issue)).join('');

    return `
      <div class="cc-board-column">
        <div class="cc-board-column-header">
          <span class="cc-board-column-title">${escapeHtml(col.label)}</span>
          <span class="cc-board-column-count">${cards.length}</span>
        </div>
        <div class="cc-board-card-list">
          ${cardHtml}
        </div>
      </div>
    `;
  }).join('');
}

function classifyIssueColumn(issue) {
  const labels = (issue.labels || []).map(l => (typeof l === 'string' ? l : l.name || '').toLowerCase());
  const state = (issue.state || '').toLowerCase();

  if (state === 'closed' || labels.includes('done')) return 'Done';
  if (labels.includes('in review') || labels.includes('review')) return 'In Review';
  if (labels.includes('in progress') || labels.includes('wip') || issue.assignees?.length > 0) return 'In Progress';
  return 'Backlog';
}

function issueLabelColor(label) {
  if (typeof label === 'object' && label.color) return `#${label.color}`;
  return 'var(--cc-text-faint)';
}

function renderBoard(issues) {
  const columns = {};
  BOARD_COLUMNS.forEach(col => columns[col] = []);

  issues.forEach(issue => {
    const col = issue.column || classifyIssueColumn(issue);
    if (columns[col]) {
      columns[col].push(issue);
    } else {
      columns['Backlog'].push(issue);
    }
  });

  dom.boardColumns.innerHTML = BOARD_COLUMNS.map(colName => {
    const cards = columns[colName];
    const cardHtml = cards.length === 0
      ? `<div class="cc-board-empty">No issues</div>`
      : cards.map(issue => renderBoardCard(issue)).join('');

    return `
      <div class="cc-board-column">
        <div class="cc-board-column-header">
          <span class="cc-board-column-title">${escapeHtml(colName)}</span>
          <span class="cc-board-column-count">${cards.length}</span>
        </div>
        <div class="cc-board-card-list">
          ${cardHtml}
        </div>
      </div>
    `;
  }).join('');
}

function renderBoardCard(issue) {
  const number = issue.number || '';
  const title = issue.title || 'Untitled';
  const assignees = (issue.assignees || []).map(a => typeof a === 'string' ? a : a.login || a.name || '').filter(Boolean);
  const labels = issue.labels || [];
  const createdAt = issue.created_at || issue.createdAt;
  const age = createdAt ? timeAgo(createdAt) : '';

  const labelsHtml = labels.map(label => {
    const name = typeof label === 'string' ? label : label.name || '';
    const color = issueLabelColor(label);
    return `<span class="cc-board-label" style="border-color: ${color}; color: ${color}">${escapeHtml(name)}</span>`;
  }).join('');

  const assigneesHtml = assignees.length > 0
    ? `<span class="cc-board-assignees">${assignees.map(a => escapeHtml(a)).join(', ')}</span>`
    : '';

  return `
    <div class="cc-board-card">
      <div class="cc-board-card-top">
        <span class="cc-board-card-number">#${escapeHtml(String(number))}</span>
        ${age ? `<span class="cc-board-card-age">${age}</span>` : ''}
      </div>
      <div class="cc-board-card-title">${escapeHtml(title)}</div>
      ${labelsHtml ? `<div class="cc-board-card-labels">${labelsHtml}</div>` : ''}
      ${assigneesHtml ? `<div class="cc-board-card-footer">${assigneesHtml}</div>` : ''}
    </div>
  `;
}

// ── Ops Tab ─────────────────────────────────────────────────

async function loadOpsData() {
  if (!state.selectedProjectId) return;

  dom.opsGrid.innerHTML = `<div class="cc-loading">Loading workflow runs...</div>`;

  try {
    const data = await apiCall('/api/actions');
    const runs = data.workflow_runs || data.runs || data || [];
    renderOps(runs);
    dom.opsLastUpdated.textContent = `Updated ${timeAgo(new Date().toISOString())}`;
  } catch (err) {
    console.error('Failed to load ops:', err);
    renderOps([]);
    dom.opsLastUpdated.textContent = 'Unable to load';
  }
}

function opsStatusClass(status, conclusion) {
  if (status === 'in_progress' || status === 'queued' || status === 'pending') return 'cc-status-pending';
  if (conclusion === 'success') return 'cc-status-success';
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') return 'cc-status-failure';
  return 'cc-status-pending';
}

function opsStatusLabel(status, conclusion) {
  if (status === 'in_progress') return 'Running';
  if (status === 'queued') return 'Queued';
  if (conclusion === 'success') return 'Passed';
  if (conclusion === 'failure') return 'Failed';
  if (conclusion === 'cancelled') return 'Cancelled';
  if (conclusion === 'timed_out') return 'Timed out';
  return status || 'Unknown';
}

function renderOps(runs) {
  if (runs.length === 0) {
    dom.opsGrid.innerHTML = `
      <div class="cc-team-empty">
        <p>No workflow runs found.</p>
        <p style="font-size: 12px; color: var(--cc-text-faint);">
          GitHub Actions runs will appear here once the project is connected.
        </p>
      </div>
    `;
    return;
  }

  dom.opsGrid.innerHTML = runs.map(run => {
    const name = run.name || run.workflow_name || 'Workflow';
    const status = run.status || '';
    const conclusion = run.conclusion || '';
    const statusCls = opsStatusClass(status, conclusion);
    const statusText = opsStatusLabel(status, conclusion);
    const updatedAt = run.updated_at || run.updatedAt || run.created_at || run.createdAt;
    const branch = run.head_branch || run.branch || '';
    const runNumber = run.run_number || '';

    return `
      <div class="cc-ops-card">
        <div class="cc-ops-card-header">
          <span class="cc-ops-status-dot ${statusCls}"></span>
          <span class="cc-ops-card-name">${escapeHtml(name)}</span>
          ${runNumber ? `<span class="cc-ops-run-number">#${escapeHtml(String(runNumber))}</span>` : ''}
        </div>
        <div class="cc-ops-card-status ${statusCls}">${escapeHtml(statusText)}</div>
        <div class="cc-ops-card-meta">
          ${branch ? `<span class="cc-ops-card-branch">${escapeHtml(branch)}</span>` : ''}
          ${updatedAt ? `<span class="cc-ops-card-time">${timeAgo(updatedAt)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ── Metrics Tab ─────────────────────────────────────────────────

async function loadMetricsData() {
  if (!state.selectedProjectId) return;

  const metricsGrid = document.getElementById('metricsGrid');
  if (!metricsGrid) return;

  metricsGrid.innerHTML = `<div class="cc-loading">Loading metrics...</div>`;

  try {
    // Fetch board and threads data to compute metrics
    const [boardData, threadsData] = await Promise.allSettled([
      apiCall('/api/board'),
      apiCall('/api/threads?limit=200'),
    ]);

    const board = boardData.status === 'fulfilled' ? boardData.value : null;
    const threads = threadsData.status === 'fulfilled' ? (threadsData.value.threads || []) : [];

    // Compute metrics from board data
    const columns = board?.columns || [];
    const totalIssues = columns.reduce((sum, c) => sum + (c.issues?.length || 0), 0);
    const openIssues = columns.filter(c => c.id !== 'done').reduce((sum, c) => sum + (c.issues?.length || 0), 0);
    const doneIssues = columns.find(c => c.id === 'done')?.issues?.length || 0;
    const inProgressIssues = columns.find(c => c.id === 'in-progress')?.issues?.length || 0;
    const inReviewIssues = columns.find(c => c.id === 'in-review')?.issues?.length || 0;

    const metrics = [
      { label: 'Total Issues', value: totalIssues, color: 'var(--cc-accent)' },
      { label: 'Open', value: openIssues, color: 'var(--cc-green)' },
      { label: 'In Progress', value: inProgressIssues, color: '#d29922' },
      { label: 'In Review', value: inReviewIssues, color: 'var(--cc-accent)' },
      { label: 'Done', value: doneIssues, color: 'var(--cc-text-muted)' },
      { label: 'Active Threads (7d)', value: threads.filter(t => {
        if (!t.updatedAt) return false;
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        return new Date(t.updatedAt).getTime() > sevenDaysAgo;
      }).length, color: 'var(--cc-accent)' },
    ];

    metricsGrid.innerHTML = metrics.map(m => `
      <div class="cc-metric-card">
        <div class="cc-metric-value" style="color: ${m.color}">${m.value}</div>
        <div class="cc-metric-label">${escapeHtml(m.label)}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load metrics:', err);
    metricsGrid.innerHTML = `<div class="cc-team-empty"><p>Unable to load metrics.</p></div>`;
  }
}

// ── Threads Tab ─────────────────────────────────────────────────

async function loadThreadsData() {
  if (!state.selectedProjectId) return;

  const threadList = document.getElementById('threadList');
  const threadCount = document.getElementById('threadCount');
  if (!threadList) return;

  threadList.innerHTML = `<div class="cc-loading">Loading threads...</div>`;

  try {
    const data = await apiCall('/api/threads?limit=50');
    const threads = data.threads || data || [];
    threadCount.textContent = `${threads.length} thread${threads.length !== 1 ? 's' : ''}`;

    if (threads.length === 0) {
      threadList.innerHTML = `
        <div class="cc-team-empty">
          <p>No threads yet.</p>
          <p style="font-size: 12px; color: var(--cc-text-faint);">
            Create workstream threads to organize project discussions.
          </p>
        </div>
      `;
      return;
    }

    threadList.innerHTML = threads.map(thread => {
      const title = thread.title || thread.id;
      const type = thread.threadType || 'chat';
      const updated = thread.updatedAt ? timeAgo(thread.updatedAt) : '';
      const participantCount = thread.participantCount || '';
      const isActive = thread.status === 'active';

      return `
        <div class="cc-thread-card ${isActive ? '' : 'cc-thread-inactive'}" data-thread-id="${escapeHtml(thread.id)}">
          <div class="cc-thread-card-header">
            <span class="cc-thread-icon">#</span>
            <span class="cc-thread-title">${escapeHtml(title)}</span>
            <span class="cc-thread-type">${escapeHtml(type)}</span>
          </div>
          <div class="cc-thread-card-meta">
            ${updated ? `<span>Updated ${updated}</span>` : ''}
            ${participantCount ? `<span>${participantCount} participants</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
    // Add click handlers to thread cards
    threadList.addEventListener('click', (e) => {
      const card = e.target.closest('.cc-thread-card');
      if (!card) return;
      const threadId = card.dataset.threadId;
      if (threadId) {
        window.open(`http://localhost:3100/#thread=${threadId}`, '_blank');
      }
    });
  } catch (err) {
    console.error('Failed to load threads:', err);
    threadList.innerHTML = `
      <div class="cc-team-empty">
        <p>Unable to load threads.</p>
        <p style="font-size: 12px; color: var(--cc-text-faint);">${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

// ── Captain Bar ──────────────────────────────────────────────────

function updateCaptainBar(message) {
  dom.captainMessage.textContent = message || 'Captain not yet configured';
}

// ── SSE (Server-Sent Events) ─────────────────────────────────────

function connectSSE() {
  // Close existing connection
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  if (!state.selectedProjectId) return;

  try {
    const url = `/api/events?projectId=${encodeURIComponent(state.selectedProjectId)}`;
    state.eventSource = new EventSource(url);

    state.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleSSEEvent(data);
      } catch {
        // Ignore parse errors
      }
    };

    state.eventSource.addEventListener('captain', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.message) {
          updateCaptainBar(data.message);
        }
      } catch {
        // Ignore parse errors
      }
    });

    state.eventSource.onerror = () => {
      // SSE will auto-reconnect; just log
      console.warn('SSE connection lost, will reconnect...');
    };
  } catch (err) {
    console.error('Failed to connect SSE:', err);
  }
}

function handleSSEEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'team_updated':
      if (state.activeTab === 'team') {
        loadTeamData();
      }
      break;

    case 'captain_message':
      if (event.payload && event.payload.message) {
        updateCaptainBar(event.payload.message);
      }
      break;

    case 'thread_created':
    case 'thread_updated':
      // Will be used in Phase 3 when Threads tab is live
      break;

    default:
      break;
  }
}

// ── Event Listeners ──────────────────────────────────────────────

// Project selection
dom.projectList.addEventListener('click', (e) => {
  const card = e.target.closest('.cc-project-card');
  if (!card) return;
  const projectId = card.dataset.projectId;
  if (projectId) {
    selectProject(projectId);
  }
});

// Tab navigation
dom.navTabs.forEach(btn => {
  btn.addEventListener('click', () => {
    showTab(btn.dataset.tab);
  });
});

// Header button handlers
document.getElementById('settingsBtn').addEventListener('click', () => {
  alert('Settings panel coming soon. Configuration will be available in a future release.');
});

document.getElementById('chatBtn').addEventListener('click', () => {
  window.open('http://localhost:3100', '_blank');
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + number to switch tabs
  if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '5') {
    e.preventDefault();
    const tabs = ['team', 'board', 'ops', 'threads', 'metrics'];
    const idx = parseInt(e.key, 10) - 1;
    if (tabs[idx] && state.selectedProjectId) {
      showTab(tabs[idx]);
    }
  }
});

// ── Initialization ───────────────────────────────────────────────

(async function init() {
  await loadProjects();
})();

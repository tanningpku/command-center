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
  activeThreadId: null,
  threads: [],
};

// ── DOM References ───────────────────────────────────────────────

const dom = {
  projectSwitcherBtn:  document.getElementById('projectSwitcherBtn'),
  projectSwitcherName: document.getElementById('projectSwitcherName'),
  projectDropdown:     document.getElementById('projectSwitcherDropdown'),
  projectDropdownList: document.getElementById('projectDropdownList'),
  tabNav:             document.getElementById('tabNav'),
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
 * Make a POST API call through the gateway proxy.
 */
async function apiPost(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.selectedProjectId) {
    headers['X-Project-Id'] = state.selectedProjectId;
  }
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || `HTTP ${res.status}`);
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
    renderProjectDropdown();

    // Auto-select first project
    if (state.projects.length > 0 && !state.selectedProjectId) {
      selectProject(state.projects[0].id);
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
    dom.projectSwitcherName.textContent = 'Connecting...';
    // Retry after 5s
    setTimeout(loadProjects, 5000);
  }
}

function renderProjectDropdown() {
  if (state.projects.length === 0) {
    dom.projectDropdownList.innerHTML = `
      <div class="cc-project-dropdown-empty">No projects registered.</div>
    `;
    return;
  }

  dom.projectDropdownList.innerHTML = state.projects.map(project => {
    const isActive = project.id === state.selectedProjectId;
    const statusClass = project.status || 'running';
    return `
      <div class="cc-project-dropdown-item ${isActive ? 'active' : ''}"
           data-project-id="${escapeHtml(project.id)}">
        <span class="cc-project-dot ${escapeHtml(statusClass)}"></span>
        <span class="cc-project-dropdown-name">${escapeHtml(project.name)}</span>
      </div>
    `;
  }).join('');
}

function toggleProjectDropdown() {
  const isOpen = dom.projectDropdown.style.display !== 'none';
  dom.projectDropdown.style.display = isOpen ? 'none' : 'block';
}

function closeProjectDropdown() {
  dom.projectDropdown.style.display = 'none';
}

function selectProject(projectId) {
  state.selectedProjectId = projectId;

  // Update dropdown highlights and close it
  renderProjectDropdown();
  closeProjectDropdown();

  // Find the project info
  const project = state.projects.find(p => p.id === projectId);

  // Update switcher button text
  dom.projectSwitcherName.textContent = project ? project.name : projectId;

  // Show tab nav
  dom.tabNav.style.display = 'flex';

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

  // Reset agent detail panel when switching tabs
  const detailPanel = document.getElementById('agentDetailPanel');
  if (detailPanel) {
    detailPanel.style.display = 'none';
    dom.teamGrid.style.display = '';
  }

  // Show selected tab
  const tabEl = document.getElementById(`tab-${tabName}`);
  if (tabEl) {
    // Threads tab needs flex layout for the split panel
    tabEl.style.display = tabName === 'threads' ? 'flex' : 'block';
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
    const data = await apiCall('/api/agents');
    const agents = data.agents || data || [];
    state.teamData = agents;
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
  const role = member.role || '';

  return `
    <div class="cc-team-card cc-team-card-clickable" data-agent-id="${escapeHtml(member.id)}">
      <div class="cc-team-card-header">
        <div class="cc-avatar ${avatarClass}">${escapeHtml(initial)}</div>
        <div>
          <div class="cc-team-card-name">${escapeHtml(displayName)}</div>
          <div class="cc-team-card-type">${escapeHtml(typeLabel)}</div>
        </div>
      </div>
      ${role ? `<div class="cc-team-card-role">${escapeHtml(role)}</div>` : ''}
      ${member.description && member.description !== role ? `<div class="cc-team-detail" style="margin-bottom: 4px;">${escapeHtml(member.description)}</div>` : ''}
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

// ── Agent Detail Panel ──────────────────────────────────────────

function showAgentDetail(agentId) {
  const member = state.teamData.find(m => m.id === agentId);
  if (!member) return;

  // Hide grid, show detail panel
  dom.teamGrid.style.display = 'none';
  const panel = document.getElementById('agentDetailPanel');
  panel.style.display = 'block';

  // Populate header
  document.getElementById('agentDetailName').textContent = member.name || member.id;
  const statusBadge = document.getElementById('agentDetailStatus');
  const status = member.status || 'offline';
  const isOnline = status === 'online' || status === 'active';
  statusBadge.textContent = isOnline ? 'Online' : 'Offline';
  statusBadge.className = `cc-agent-detail-status-badge ${isOnline ? 'cc-status-online' : 'cc-status-offline'}`;

  // Role
  const roleEl = document.getElementById('agentDetailRole');
  roleEl.textContent = member.role || '';
  roleEl.style.display = member.role ? 'block' : 'none';

  // Load KB identity and file list
  loadAgentIdentity(agentId);
  loadAgentKbList(agentId);

  // Hide KB viewer if open
  document.getElementById('agentKbViewer').style.display = 'none';
}

function hideAgentDetail() {
  document.getElementById('agentDetailPanel').style.display = 'none';
  dom.teamGrid.style.display = '';
}

async function loadAgentIdentity(agentId) {
  const el = document.getElementById('agentDetailIdentity');
  el.textContent = 'Loading...';

  try {
    const data = await apiCall(`/api/kb/read?file=identity.md&agent=${encodeURIComponent(agentId)}`);
    el.textContent = data.content || '(empty)';
  } catch {
    el.textContent = '(No system prompt found)';
  }
}

async function loadAgentKbList(agentId) {
  const el = document.getElementById('agentKbList');
  el.innerHTML = '<div class="cc-loading">Loading KB files...</div>';

  try {
    const data = await apiCall(`/api/kb/list?agent=${encodeURIComponent(agentId)}`);
    const files = data.files || [];

    if (files.length === 0) {
      el.innerHTML = '<div class="cc-text-muted" style="font-size: 12px;">No KB files.</div>';
      return;
    }

    el.innerHTML = files.map(f => `
      <div class="cc-agent-kb-file" data-agent-id="${escapeHtml(agentId)}" data-file="${escapeHtml(f)}">
        <span class="cc-agent-kb-file-icon">&#128196;</span>
        <span class="cc-agent-kb-file-name">${escapeHtml(f)}</span>
      </div>
    `).join('');
  } catch {
    el.innerHTML = '<div class="cc-text-muted" style="font-size: 12px;">Unable to load KB files.</div>';
  }
}

async function openKbFile(agentId, filename) {
  const viewer = document.getElementById('agentKbViewer');
  const titleEl = document.getElementById('agentKbViewerTitle');
  const contentEl = document.getElementById('agentKbViewerContent');

  titleEl.textContent = filename;
  contentEl.textContent = 'Loading...';
  viewer.style.display = 'block';

  try {
    const data = await apiCall(`/api/kb/read?file=${encodeURIComponent(filename)}&agent=${encodeURIComponent(agentId)}`);
    contentEl.textContent = data.content || '(empty)';
  } catch {
    contentEl.textContent = '(Unable to read file)';
  }
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
    state.threads = threads;
    threadCount.textContent = `${threads.length} thread${threads.length !== 1 ? 's' : ''}`;

    if (threads.length === 0) {
      threadList.innerHTML = `
        <div class="cc-thread-sidebar-empty">
          <p>No threads yet.</p>
        </div>
      `;
      showChatEmptyState();
      return;
    }

    renderThreadSidebar(threads);

    // If we had an active thread, re-select it; otherwise show empty
    if (state.activeThreadId && threads.find(t => t.id === state.activeThreadId)) {
      selectThread(state.activeThreadId);
    } else {
      showChatEmptyState();
    }
  } catch (err) {
    console.error('Failed to load threads:', err);
    threadList.innerHTML = `
      <div class="cc-thread-sidebar-empty">
        <p>Unable to load threads.</p>
        <p style="font-size: 11px; color: var(--cc-text-faint);">${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

function renderThreadSidebar(threads) {
  const threadList = document.getElementById('threadList');
  threadList.innerHTML = threads.map(thread => {
    const title = thread.title || thread.id;
    const isSelected = thread.id === state.activeThreadId;
    const isActive = thread.status === 'active';
    const updated = thread.updatedAt ? timeAgo(thread.updatedAt) : '';

    return `
      <div class="cc-thread-card ${isSelected ? 'cc-thread-selected' : ''} ${isActive ? '' : 'cc-thread-inactive'}" data-thread-id="${escapeHtml(thread.id)}">
        <div class="cc-thread-card-header">
          <span class="cc-thread-icon">#</span>
          <span class="cc-thread-title">${escapeHtml(title)}</span>
        </div>
        ${updated ? `<div class="cc-thread-card-meta"><span>${updated}</span></div>` : ''}
      </div>
    `;
  }).join('');
}

function showChatEmptyState() {
  document.getElementById('chatEmptyState').style.display = 'flex';
  document.getElementById('chatHeader').style.display = 'none';
  document.getElementById('chatMessages').style.display = 'none';
  document.getElementById('chatInputBar').style.display = 'none';
}

function showChatArea(title) {
  document.getElementById('chatEmptyState').style.display = 'none';
  document.getElementById('chatHeader').style.display = 'flex';
  document.getElementById('chatMessages').style.display = 'flex';
  document.getElementById('chatInputBar').style.display = 'flex';
  document.getElementById('chatThreadTitle').textContent = title || '';
}

async function selectThread(threadId) {
  state.activeThreadId = threadId;

  // Update sidebar highlights
  renderThreadSidebar(state.threads);

  // Find thread info
  const thread = state.threads.find(t => t.id === threadId);
  const title = thread ? (thread.title || thread.id) : threadId;

  showChatArea(title);
  await loadChatMessages(threadId);
}

async function loadChatMessages(threadId) {
  const chatMessages = document.getElementById('chatMessages');
  chatMessages.innerHTML = `<div class="cc-loading">Loading messages...</div>`;

  try {
    const data = await apiCall(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=50`);
    const messages = data.messages || data || [];
    renderChatMessages(messages);
  } catch (err) {
    console.error('Failed to load messages:', err);
    chatMessages.innerHTML = `
      <div class="cc-chat-error">Unable to load messages: ${escapeHtml(err.message)}</div>
    `;
  }
}

function renderChatMessages(messages) {
  const chatMessages = document.getElementById('chatMessages');

  if (messages.length === 0) {
    chatMessages.innerHTML = `
      <div class="cc-chat-no-messages">No messages yet. Start the conversation!</div>
    `;
    return;
  }

  chatMessages.innerHTML = messages.map(msg => renderChatBubble(msg)).join('');
  scrollChatToBottom();
}

function renderChatBubble(msg) {
  const role = msg.role || 'user';
  const isAssistant = role === 'assistant';
  const senderName = msg.sender || msg.assistantName || (isAssistant ? 'Captain' : 'You');
  const text = msg.text || msg.content || '';
  const time = msg.createdAt || msg.timestamp;
  const timeStr = time ? formatMessageTime(time) : '';
  const bubbleClass = isAssistant ? 'cc-message-assistant' : 'cc-message-user';

  return `
    <div class="cc-message ${bubbleClass}">
      <div class="cc-message-sender">${escapeHtml(senderName)}</div>
      <div class="cc-message-text">${escapeHtml(text)}</div>
      ${timeStr ? `<div class="cc-message-time">${escapeHtml(timeStr)}</div>` : ''}
    </div>
  `;
}

function formatMessageTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return timeStr;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${timeStr}`;
}

function scrollChatToBottom() {
  const chatMessages = document.getElementById('chatMessages');
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

function appendChatMessage(msg) {
  const chatMessages = document.getElementById('chatMessages');
  // Remove "no messages" placeholder if present
  const noMsgs = chatMessages.querySelector('.cc-chat-no-messages');
  if (noMsgs) noMsgs.remove();

  const div = document.createElement('div');
  div.innerHTML = renderChatBubble(msg);
  chatMessages.appendChild(div.firstElementChild);
  scrollChatToBottom();
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !state.activeThreadId) return;

  input.value = '';

  // Optimistic append
  appendChatMessage({
    role: 'user',
    sender: 'You',
    text: text,
    createdAt: new Date().toISOString(),
  });

  try {
    await apiPost('/api/harness/message/send', {
      thread_id: state.activeThreadId,
      text: text,
      channel: 'webui',
    });
  } catch (err) {
    console.error('Failed to send message:', err);
    // Append error indicator
    appendChatMessage({
      role: 'assistant',
      sender: 'System',
      text: `Failed to send message: ${err.message}`,
      createdAt: new Date().toISOString(),
    });
  }
}

async function createNewThread() {
  const title = prompt('Thread title:');
  if (!title) return;

  try {
    const result = await apiPost('/api/threads', {
      title: title,
      participants: ['captain', 'ning'],
    });
    const newThread = result.thread || result;
    // Reload thread list and select the new thread
    await loadThreadsData();
    if (newThread && newThread.id) {
      selectThread(newThread.id);
    }
  } catch (err) {
    console.error('Failed to create thread:', err);
    alert(`Failed to create thread: ${err.message}`);
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
      if (state.activeTab === 'threads') {
        loadThreadsData();
      }
      break;

    case 'message_created':
    case 'new_message': {
      const msg = event.payload || event;
      const msgThreadId = msg.threadId || msg.thread_id;
      if (msgThreadId && msgThreadId === state.activeThreadId && state.activeTab === 'threads') {
        // Only append assistant messages (user messages are optimistically added)
        if (msg.role === 'assistant') {
          appendChatMessage(msg);
        }
      }
      break;
    }

    default:
      break;
  }
}

// ── New Project Modal ─────────────────────────────────────────────

function openNewProjectModal() {
  const modal = document.getElementById('newProjectModal');
  const errorEl = document.getElementById('newProjectError');
  errorEl.style.display = 'none';
  document.getElementById('projectDir').value = '';
  document.getElementById('captainName').value = 'Captain';
  modal.style.display = 'flex';
  document.getElementById('projectDir').focus();
}

function closeNewProjectModal() {
  document.getElementById('newProjectModal').style.display = 'none';
}

document.getElementById('newProjectBtn').addEventListener('click', openNewProjectModal);
document.getElementById('modalCloseBtn').addEventListener('click', closeNewProjectModal);

// Close modal on overlay click
document.getElementById('newProjectModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeNewProjectModal();
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNewProjectModal();
});

document.getElementById('newProjectForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const directory = document.getElementById('projectDir').value.trim();
  const captainName = document.getElementById('captainName').value.trim();
  const errorEl = document.getElementById('newProjectError');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  if (!directory || !captainName) return;

  errorEl.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating...';

  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory, captainName }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // Success — close modal, reload projects, select the new one
    closeNewProjectModal();
    const newId = data.project?.id;
    state.selectedProjectId = null; // Reset so loadProjects doesn't skip
    await loadProjects();
    if (newId) {
      selectProject(newId);
      showTab('threads');
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Project';
  }
});

// ── Event Listeners ──────────────────────────────────────────────

// Team card click — open agent detail
dom.teamGrid.addEventListener('click', (e) => {
  const card = e.target.closest('.cc-team-card-clickable');
  if (!card) return;
  const agentId = card.dataset.agentId;
  if (agentId) showAgentDetail(agentId);
});

// Agent detail back button
document.getElementById('agentDetailBack').addEventListener('click', hideAgentDetail);

// KB file list click — open file viewer
document.getElementById('agentKbList').addEventListener('click', (e) => {
  const fileEl = e.target.closest('.cc-agent-kb-file');
  if (!fileEl) return;
  const agentId = fileEl.dataset.agentId;
  const filename = fileEl.dataset.file;
  if (agentId && filename) openKbFile(agentId, filename);
});

// KB viewer close button
document.getElementById('agentKbViewerClose').addEventListener('click', () => {
  document.getElementById('agentKbViewer').style.display = 'none';
});

// Project switcher dropdown toggle
dom.projectSwitcherBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleProjectDropdown();
});

// Project selection from dropdown
dom.projectDropdownList.addEventListener('click', (e) => {
  const item = e.target.closest('.cc-project-dropdown-item');
  if (!item) return;
  const projectId = item.dataset.projectId;
  if (projectId) selectProject(projectId);
});

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.cc-project-switcher')) {
    closeProjectDropdown();
  }
});

// Tab navigation
dom.navTabs.forEach(btn => {
  btn.addEventListener('click', () => {
    showTab(btn.dataset.tab);
  });
});

// Thread sidebar click — select a thread
document.getElementById('threadList').addEventListener('click', (e) => {
  const card = e.target.closest('.cc-thread-card');
  if (!card) return;
  const threadId = card.dataset.threadId;
  if (threadId) {
    selectThread(threadId);
  }
});

// Chat send button
document.getElementById('chatSendBtn').addEventListener('click', () => {
  sendChatMessage();
});

// Chat input — Enter to send
document.getElementById('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// New thread button
document.getElementById('newThreadBtn').addEventListener('click', () => {
  createNewThread();
});

// Header button handlers
document.getElementById('settingsBtn').addEventListener('click', () => {
  alert('Settings panel coming soon. Configuration will be available in a future release.');
});

document.getElementById('chatBtn').addEventListener('click', () => {
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  const projectPort = project ? project.port : 3100;
  window.open(`http://localhost:${projectPort}`, '_blank');
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

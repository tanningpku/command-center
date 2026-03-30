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
  tasksByThreadId: {},
  agentDetailId: null,       // Currently open agent detail panel
  agentDetailTab: 'instruction', // 'instruction' or 'kb'
  unreadThreads: {},         // threadId → true if has unread messages
  chatHasMore: false,        // true if more messages available before current page
  chatOldestTimestamp: null,  // createdAt of earliest loaded message
  donePage: 0,               // current page index for Done column pagination
};

// ── DOM References ───────────────────────────────────────────────

const dom = {
  projectSelect:      document.getElementById('projectSelect'),
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

// ── Unread tracking ─────────────────────────────────────────────

function getLastReadKey() {
  return `cc-lastRead-${state.selectedProjectId || 'default'}`;
}

function getLastReadMap() {
  try {
    return JSON.parse(localStorage.getItem(getLastReadKey()) || '{}');
  } catch { return {}; }
}

function markThreadRead(threadId) {
  const map = getLastReadMap();
  map[threadId] = new Date().toISOString();
  localStorage.setItem(getLastReadKey(), JSON.stringify(map));
  delete state.unreadThreads[threadId];
}

function computeUnreadState(threads) {
  const map = getLastReadMap();
  state.unreadThreads = {};
  for (const t of threads) {
    if (t.id === state.activeThreadId) continue;
    const lastRead = map[t.id];
    if (!lastRead || (t.updatedAt && t.updatedAt > lastRead)) {
      state.unreadThreads[t.id] = true;
    }
  }
}

// Render markdown for chat messages using marked.js
function renderMarkdown(str) {
  if (typeof marked === 'undefined') return escapeHtml(str);
  try {
    // Escape raw HTML tags before markdown parsing to prevent DOM injection
    // (e.g. literal <textarea> in message content would swallow subsequent HTML)
    const safe = String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return marked.parse(safe, { breaks: true, gfm: true });
  } catch (_) {
    return escapeHtml(str);
  }
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
 * Make an API call with agent scope (adds agent query param for KB endpoints).
 */
async function agentApiCall(path, agentId) {
  const sep = path.includes('?') ? '&' : '?';
  return apiCall(`${path}${sep}agent=${encodeURIComponent(agentId)}`);
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

    // Auto-select: use saved project if valid, otherwise first project
    if (state.projects.length > 0 && !state.selectedProjectId) {
      const savedProjectId = localStorage.getItem('cc-selectedProjectId');
      const target = savedProjectId && state.projects.find(p => p.id === savedProjectId)
        ? savedProjectId
        : state.projects[0].id;
      selectProject(target);
    }
  } catch (err) {
    console.error('Failed to load projects:', err);
    dom.projectSelect.innerHTML = `<option value="">Retrying...</option>`;
    // Retry after 5s
    setTimeout(loadProjects, 5000);
  }
}

function renderProjectList() {
  if (state.projects.length === 0) {
    dom.projectSelect.innerHTML = `<option value="">No projects</option>`;
    return;
  }

  dom.projectSelect.innerHTML = state.projects.map(project => {
    const isSelected = project.id === state.selectedProjectId;
    const label = project.name || project.id;
    return `<option value="${escapeHtml(project.id)}" ${isSelected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function selectProject(projectId) {
  state.selectedProjectId = projectId;
  localStorage.setItem('cc-selectedProjectId', projectId);

  // Update the header dropdown to reflect current selection
  dom.projectSelect.value = projectId;

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
  localStorage.setItem('cc-activeTab', tabName);

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
    <div class="cc-team-card cc-team-card-clickable" data-agent-id="${escapeHtml(member.id)}">
      <div class="cc-team-card-header">
        <div class="cc-avatar ${avatarClass}">${escapeHtml(initial)}</div>
        <div>
          <div class="cc-team-card-name">${escapeHtml(displayName)}</div>
          <div class="cc-team-card-type">${escapeHtml(typeLabel)}</div>
        </div>
      </div>
      ${member.role ? `<div class="cc-team-card-role">${escapeHtml(member.role)}</div>` : ''}
      ${member.description && !member.role ? `<div class="cc-team-detail" style="margin-bottom: 4px;">${escapeHtml(member.description)}</div>` : ''}
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

function openAgentDetail(agentId) {
  state.agentDetailId = agentId;
  state.agentDetailTab = 'instruction';
  renderAgentDetailPanel();
}

function closeAgentDetail() {
  state.agentDetailId = null;
  const panel = document.getElementById('agentDetailPanel');
  if (panel) panel.remove();
}

function renderAgentDetailPanel() {
  const member = state.teamData.find(m => m.id === state.agentDetailId);
  if (!member) return;

  // Remove existing panel if any
  let panel = document.getElementById('agentDetailPanel');
  if (panel) panel.remove();

  const displayName = member.name || member.id;
  const isAgent = member.type === 'agent' || member.type === 'assistant' || member.type === 'personal' || member.type === 'coding' || member.type === 'captain';
  const initial = (displayName).charAt(0).toUpperCase();
  const avatarClass = isAgent ? 'cc-avatar-agent' : 'cc-avatar-user';
  const activeTab = state.agentDetailTab;

  const panelHtml = `
    <div id="agentDetailPanel" class="cc-agent-detail-overlay">
      <div class="cc-agent-detail-panel">
        <div class="cc-agent-detail-header">
          <div class="cc-agent-detail-header-info">
            <div class="cc-avatar ${avatarClass}" style="width:36px;height:36px;font-size:15px;">${escapeHtml(initial)}</div>
            <div>
              <div class="cc-agent-detail-name">${escapeHtml(displayName)}</div>
              ${member.role ? `<div class="cc-agent-detail-role">${escapeHtml(member.role)}</div>` : ''}
            </div>
          </div>
          <button class="cc-agent-detail-close" title="Close">&times;</button>
        </div>
        <div class="cc-agent-detail-tabs">
          <button class="cc-agent-detail-tab ${activeTab === 'instruction' ? 'active' : ''}" data-detail-tab="instruction">System Instruction</button>
          <button class="cc-agent-detail-tab ${activeTab === 'kb' ? 'active' : ''}" data-detail-tab="kb">Knowledge Base</button>
        </div>
        <div class="cc-agent-detail-body" id="agentDetailBody">
          <div class="cc-loading">Loading...</div>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', panelHtml);

  // Bind close
  document.querySelector('.cc-agent-detail-close').addEventListener('click', closeAgentDetail);
  document.getElementById('agentDetailPanel').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAgentDetail();
  });

  // Bind tab switches
  document.querySelectorAll('.cc-agent-detail-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.agentDetailTab = btn.dataset.detailTab;
      document.querySelectorAll('.cc-agent-detail-tab').forEach(b => b.classList.toggle('active', b.dataset.detailTab === state.agentDetailTab));
      loadAgentDetailContent();
    });
  });

  loadAgentDetailContent();
}

async function loadAgentDetailContent() {
  const body = document.getElementById('agentDetailBody');
  if (!body || !state.agentDetailId) return;

  body.innerHTML = `<div class="cc-loading">Loading...</div>`;

  if (state.agentDetailTab === 'instruction') {
    await loadAgentInstruction(body, state.agentDetailId);
  } else {
    await loadAgentKbList(body, state.agentDetailId);
  }
}

async function loadAgentInstruction(container, agentId) {
  try {
    const data = await agentApiCall('/api/kb/read?file=identity.md', agentId);
    const content = data.content || '';
    if (!content) {
      container.innerHTML = `<div class="cc-agent-detail-empty">No system instruction found (identity.md).</div>`;
      return;
    }
    container.innerHTML = `<pre class="cc-agent-detail-pre">${escapeHtml(content)}</pre>`;
  } catch (err) {
    container.innerHTML = `<div class="cc-agent-detail-empty">Unable to load system instruction: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadAgentKbList(container, agentId) {
  try {
    const data = await agentApiCall('/api/kb/list', agentId);
    const files = data.files || [];
    if (files.length === 0) {
      container.innerHTML = `<div class="cc-agent-detail-empty">No knowledge base files found.</div>`;
      return;
    }
    container.innerHTML = `
      <div class="cc-kb-file-list" id="kbFileList">
        ${files.map(f => `
          <div class="cc-kb-file-item" data-kb-file="${escapeHtml(f)}">
            <span class="cc-kb-file-icon">M</span>
            <span class="cc-kb-file-name">${escapeHtml(f)}</span>
          </div>
        `).join('')}
      </div>
      <div class="cc-kb-file-content" id="kbFileContent" style="display:none;">
        <button class="cc-kb-back-btn" id="kbBackBtn">Back to files</button>
        <div class="cc-kb-file-title" id="kbFileTitle"></div>
        <pre class="cc-agent-detail-pre" id="kbFileBody"></pre>
      </div>
    `;

    // Bind file clicks
    document.getElementById('kbFileList').addEventListener('click', (e) => {
      const item = e.target.closest('.cc-kb-file-item');
      if (!item) return;
      const filename = item.dataset.kbFile;
      if (filename) loadKbFileContent(agentId, filename);
    });
  } catch (err) {
    container.innerHTML = `<div class="cc-agent-detail-empty">Unable to load KB files: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadKbFileContent(agentId, filename) {
  const fileList = document.getElementById('kbFileList');
  const contentArea = document.getElementById('kbFileContent');
  const titleEl = document.getElementById('kbFileTitle');
  const bodyEl = document.getElementById('kbFileBody');
  const backBtn = document.getElementById('kbBackBtn');

  if (!fileList || !contentArea) return;

  fileList.style.display = 'none';
  contentArea.style.display = 'block';
  titleEl.textContent = filename;
  bodyEl.textContent = 'Loading...';

  // Bind back button
  backBtn.onclick = () => {
    fileList.style.display = 'flex';
    contentArea.style.display = 'none';
  };

  try {
    const data = await agentApiCall(`/api/kb/read?file=${encodeURIComponent(filename)}`, agentId);
    bodyEl.textContent = data.content || '(empty)';
  } catch (err) {
    bodyEl.textContent = `Error: ${err.message}`;
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
  state._lastBoardTasks = tasks;
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

  const DONE_PAGE_SIZE = 10;

  dom.boardColumns.innerHTML = BOARD_COLUMNS.map(colName => {
    const cards = columns[colName];
    const isDone = colName === 'Done';
    const totalPages = isDone ? Math.max(1, Math.ceil(cards.length / DONE_PAGE_SIZE)) : 1;
    if (isDone) state.donePage = Math.min(state.donePage, totalPages - 1);
    const visibleCards = isDone && cards.length > DONE_PAGE_SIZE
      ? cards.slice(state.donePage * DONE_PAGE_SIZE, (state.donePage + 1) * DONE_PAGE_SIZE)
      : cards;

    const cardHtml = cards.length === 0
      ? `<div class="cc-board-empty">No tasks</div>`
      : visibleCards.map(task => renderTaskCard(task)).join('');

    const paginationHtml = isDone && totalPages > 1
      ? `<div class="cc-board-pagination">
          <button class="cc-board-page-btn" data-dir="prev" ${state.donePage === 0 ? 'disabled' : ''}>&lt;</button>
          <span class="cc-board-page-info">${state.donePage + 1} / ${totalPages}</span>
          <button class="cc-board-page-btn" data-dir="next" ${state.donePage >= totalPages - 1 ? 'disabled' : ''}>&gt;</button>
        </div>`
      : '';

    return `
      <div class="cc-board-column" data-col="${escapeHtml(colName)}">
        <div class="cc-board-column-header">
          <span class="cc-board-column-title">${escapeHtml(colName)}</span>
          <span class="cc-board-column-count">${cards.length}</span>
        </div>
        <div class="cc-board-card-list">
          ${cardHtml}
          ${paginationHtml}
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

  const threadId = task.threadId || '';
  return `
    <div class="cc-board-card${threadId ? ' cc-board-card-clickable' : ''}" ${threadId ? `data-thread-id="${escapeHtml(threadId)}"` : ''}>
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

  dom.opsGrid.innerHTML = `<div class="cc-loading">Loading ops...</div>`;

  try {
    const data = await apiCall('/api/ops');
    const runs = data.builds || data.workflow_runs || data.runs || [];
    const pulls = data.pulls || [];
    renderOps(runs, pulls);
    dom.opsLastUpdated.textContent = `Updated ${timeAgo(data.lastUpdated || new Date().toISOString())}`;
  } catch (err) {
    console.error('Failed to load ops:', err);
    renderOps([], []);
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

function renderOps(runs, pulls = []) {
  if (runs.length === 0 && pulls.length === 0) {
    dom.opsGrid.innerHTML = `
      <div class="cc-team-empty">
        <p>No workflow runs or pull requests found.</p>
        <p style="font-size: 12px; color: var(--cc-text-faint);">
          GitHub data will appear here once the project is connected.
        </p>
      </div>
    `;
    return;
  }

  let html = '';

  // CI Runs section
  if (runs.length > 0) {
    html += `<div class="cc-ops-section-label" style="grid-column: 1 / -1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cc-text-muted); margin-bottom: 4px;">CI Runs</div>`;
    html += runs.map(run => {
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

  // Pull Requests section
  if (pulls.length > 0) {
    html += `<div class="cc-ops-section-label" style="grid-column: 1 / -1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--cc-text-muted); margin: 12px 0 4px;">Pull Requests</div>`;
    html += pulls.map(pr => {
      const number = pr.number || '';
      const title = pr.title || 'Untitled PR';
      const author = pr.author || pr.user?.login || '';
      const reviewRequests = pr.reviewRequests || pr.requested_reviewers || [];
      const createdAt = pr.createdAt || pr.created_at;
      const age = createdAt ? timeAgo(createdAt) : '';

      return `
        <div class="cc-ops-card">
          <div class="cc-ops-card-header">
            <span class="cc-ops-status-dot cc-status-pending"></span>
            <span class="cc-ops-card-name">${escapeHtml(title)}</span>
            <span class="cc-ops-run-number">#${escapeHtml(String(number))}</span>
          </div>
          <div class="cc-ops-card-meta">
            ${author ? `<span class="cc-ops-card-branch">${escapeHtml(author)}</span>` : ''}
            ${reviewRequests.length > 0 ? `<span style="color: var(--cc-text-faint);">Review: ${reviewRequests.map(r => escapeHtml(typeof r === 'string' ? r : r.login || '')).join(', ')}</span>` : ''}
            ${age ? `<span class="cc-ops-card-time">${age}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  dom.opsGrid.innerHTML = html;
}

// ── Metrics Tab ─────────────────────────────────────────────────

async function loadMetricsData() {
  if (!state.selectedProjectId) return;

  const metricsGrid = document.getElementById('metricsGrid');
  if (!metricsGrid) return;

  metricsGrid.innerHTML = `<div class="cc-loading">Loading metrics...</div>`;

  try {
    const [taskData, threadsData] = await Promise.allSettled([
      apiCall('/api/tasks'),
      apiCall('/api/threads?limit=200'),
    ]);

    const tasks = taskData.status === 'fulfilled' ? (taskData.value.tasks || []) : [];
    const threads = threadsData.status === 'fulfilled' ? (threadsData.value.threads || []) : [];

    // Count tasks by state
    const stateCounts = {};
    tasks.forEach(t => {
      stateCounts[t.state] = (stateCounts[t.state] || 0) + 1;
    });

    const metrics = [
      { label: 'Total Tasks', value: tasks.length, color: 'var(--cc-accent)' },
      { label: 'In Progress', value: (stateCounts['in_progress'] || 0) + (stateCounts['assigned'] || 0), color: '#d29922' },
      { label: 'In Review', value: (stateCounts['in_review'] || 0) + (stateCounts['qa'] || 0), color: 'var(--cc-accent)' },
      { label: 'Blocked', value: stateCounts['blocked'] || 0, color: '#f85149' },
      { label: 'Done', value: stateCounts['done'] || 0, color: 'var(--cc-green)' },
      { label: 'Active Threads', value: threads.filter(t => t.status === 'active').length, color: 'var(--cc-text-muted)' },
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
    const [threadsResult, tasksResult] = await Promise.allSettled([
      apiCall('/api/threads?limit=50'),
      apiCall('/api/tasks'),
    ]);
    const data = threadsResult.status === 'fulfilled' ? threadsResult.value : {};
    const threads = data.threads || data || [];
    const tasksData = tasksResult.status === 'fulfilled' ? tasksResult.value : {};
    const tasks = tasksData.tasks || [];

    // Build task-by-threadId lookup
    state.tasksByThreadId = {};
    tasks.forEach(t => {
      if (t.threadId) state.tasksByThreadId[t.threadId] = t;
    });

    // Pin main thread to top, rest sorted by updatedAt (API default)
    threads.sort((a, b) => {
      if (a.id === 'main') return -1;
      if (b.id === 'main') return 1;
      return 0;
    });
    state.threads = threads;
    computeUnreadState(threads);
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

function formatParticipants(participants) {
  if (!participants || participants.length === 0) return '';
  return participants.map(p => escapeHtml(p.participantId)).join(', ');
}

function taskStateBadge(task) {
  if (!task) return '';
  const stateLabels = {
    created: 'created', assigned: 'assigned', in_progress: 'in progress',
    in_review: 'in review', qa: 'QA', blocked: 'blocked',
    done: 'done', cancelled: 'cancelled',
  };
  const stateClasses = {
    created: 'grey', assigned: 'grey', in_progress: 'blue',
    in_review: 'yellow', qa: 'yellow', blocked: 'red',
    done: 'green', cancelled: 'grey',
  };
  const label = stateLabels[task.state] || task.state;
  const cls = stateClasses[task.state] || 'grey';
  return `<span class="cc-task-badge cc-task-badge-${escapeHtml(cls)}">${escapeHtml(label)}</span>`;
}

function renderThreadCard(thread) {
  const title = thread.title || thread.id;
  const isSelected = thread.id === state.activeThreadId;
  const isActive = thread.status === 'active';
  const isPinned = thread.id === 'main';
  const isUnread = !isSelected && state.unreadThreads[thread.id];
  const updated = thread.updatedAt ? timeAgo(thread.updatedAt) : '';
  const participantNames = formatParticipants(thread.participants);
  const task = state.tasksByThreadId[thread.id];

  return `
    <div class="cc-thread-card ${isSelected ? 'cc-thread-selected' : ''} ${isActive ? '' : 'cc-thread-inactive'} ${isPinned ? 'cc-thread-pinned' : ''} ${isUnread ? 'cc-thread-unread' : ''}" data-thread-id="${escapeHtml(thread.id)}">
      <div class="cc-thread-card-header">
        <span class="cc-thread-icon">${isPinned ? '=' : '#'}</span>
        <span class="cc-thread-title">${escapeHtml(title)}</span>
        ${isUnread ? '<span class="cc-unread-dot"></span>' : ''}
        ${taskStateBadge(task)}
      </div>
      <div class="cc-thread-card-meta">
        ${participantNames ? `<span class="cc-thread-participants">${participantNames}</span>` : ''}
        ${updated ? `<span>${updated}</span>` : ''}
      </div>
    </div>
  `;
}

function renderThreadSidebar(threads) {
  const threadList = document.getElementById('threadList');
  const completedStates = new Set(['done', 'cancelled']);

  const activeThreads = [];
  const completedThreads = [];

  threads.forEach(thread => {
    const task = state.tasksByThreadId[thread.id];
    if (task && completedStates.has(task.state) && thread.id !== 'main') {
      completedThreads.push(thread);
    } else {
      activeThreads.push(thread);
    }
  });

  let html = activeThreads.map(renderThreadCard).join('');

  if (completedThreads.length > 0) {
    html += `
      <div class="cc-thread-fold">
        <div class="cc-thread-fold-header" onclick="this.parentElement.classList.toggle('cc-thread-fold-open')">
          <span class="cc-thread-fold-chevron"></span>
          <span>Completed (${completedThreads.length})</span>
        </div>
        <div class="cc-thread-fold-body">
          ${completedThreads.map(renderThreadCard).join('')}
        </div>
      </div>
    `;
  }

  threadList.innerHTML = html;
}

function showChatEmptyState() {
  document.getElementById('chatEmptyState').style.display = 'flex';
  document.getElementById('chatHeader').style.display = 'none';
  document.getElementById('chatMessages').style.display = 'none';
  document.getElementById('chatInputBar').style.display = 'none';
}

function showChatArea(title, participants) {
  document.getElementById('chatEmptyState').style.display = 'none';
  document.getElementById('chatHeader').style.display = 'flex';
  document.getElementById('chatMessages').style.display = 'flex';
  document.getElementById('chatInputBar').style.display = 'flex';
  document.getElementById('chatThreadTitle').textContent = title || '';
  const participantsEl = document.getElementById('chatThreadParticipants');
  if (participantsEl) {
    participantsEl.textContent = participants ? participants : '';
  }
}

async function selectThread(threadId) {
  state.activeThreadId = threadId;
  localStorage.setItem('cc-activeThreadId', threadId);
  markThreadRead(threadId);

  // Update sidebar highlights
  renderThreadSidebar(state.threads);

  // Find thread info
  const thread = state.threads.find(t => t.id === threadId);
  const title = thread ? (thread.title || thread.id) : threadId;
  const participantNames = thread ? formatParticipants(thread.participants) : '';

  showChatArea(title, participantNames);
  await loadChatMessages(threadId);
}

const MESSAGES_PER_PAGE = 50;

async function loadChatMessages(threadId) {
  const chatMessages = document.getElementById('chatMessages');
  chatMessages.innerHTML = `<div class="cc-loading">Loading messages...</div>`;
  state.chatHasMore = false;
  state.chatOldestTimestamp = null;

  try {
    const data = await apiCall(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=${MESSAGES_PER_PAGE}`);
    const messages = data.messages || data || [];
    state.chatHasMore = messages.length >= MESSAGES_PER_PAGE;
    if (messages.length > 0) {
      state.chatOldestTimestamp = messages[0].createdAt;
    }
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

  const loadMoreHtml = state.chatHasMore
    ? `<button class="cc-load-more-btn" onclick="loadOlderMessages()">Load older messages</button>`
    : '';
  chatMessages.innerHTML = loadMoreHtml + messages.map(msg => renderChatBubble(msg)).join('');
  scrollChatToBottom();
}

async function loadOlderMessages() {
  if (!state.activeThreadId || !state.chatOldestTimestamp) return;

  const btn = document.querySelector('.cc-load-more-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Loading...';
  }

  try {
    const before = encodeURIComponent(state.chatOldestTimestamp);
    const data = await apiCall(
      `/api/threads/${encodeURIComponent(state.activeThreadId)}/messages?limit=${MESSAGES_PER_PAGE}&before=${before}`
    );
    const older = data.messages || data || [];
    if (older.length === 0) {
      state.chatHasMore = false;
      if (btn) btn.remove();
      return;
    }

    state.chatHasMore = older.length >= MESSAGES_PER_PAGE;
    state.chatOldestTimestamp = older[0].createdAt;

    // Prepend while preserving scroll position
    const chatMessages = document.getElementById('chatMessages');
    const prevScrollHeight = chatMessages.scrollHeight;

    // Remove old load-more button
    if (btn) btn.remove();

    // Build new HTML: optional new button + older messages
    const fragment = document.createDocumentFragment();
    if (state.chatHasMore) {
      const newBtn = document.createElement('button');
      newBtn.className = 'cc-load-more-btn';
      newBtn.textContent = 'Load older messages';
      newBtn.onclick = loadOlderMessages;
      fragment.appendChild(newBtn);
    }
    for (const msg of older) {
      const div = document.createElement('div');
      div.innerHTML = renderChatBubble(msg);
      fragment.appendChild(div.firstElementChild);
    }
    chatMessages.insertBefore(fragment, chatMessages.firstChild);

    // Restore scroll position so view doesn't jump
    requestAnimationFrame(() => {
      chatMessages.scrollTop = chatMessages.scrollHeight - prevScrollHeight;
    });
  } catch (err) {
    console.error('Failed to load older messages:', err);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Load older messages';
    }
  }
}

function renderImageGrid(imagePaths) {
  if (!imagePaths || !imagePaths.length) return '';
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const filtered = imagePaths.filter(p => imageExts.some(ext => p.toLowerCase().endsWith(ext)));
  if (!filtered.length) return '';
  const imgs = filtered.map(p => {
    const src = `/api/harness/media?path=${encodeURIComponent(p)}`;
    return `<img class="cc-chat-image" src="${escapeHtml(src)}" alt="uploaded image" loading="lazy" onclick="openImageLightbox('${escapeHtml(src)}')" />`;
  }).join('');
  return `<div class="cc-chat-image-grid">${imgs}</div>`;
}

function openImageLightbox(src) {
  let overlay = document.getElementById('cc-lightbox');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'cc-lightbox';
    overlay.className = 'cc-lightbox-overlay';
    overlay.innerHTML = '<img class="cc-lightbox-img" />';
    overlay.addEventListener('click', () => overlay.classList.remove('active'));
    document.body.appendChild(overlay);
  }
  overlay.querySelector('img').src = src;
  overlay.classList.add('active');
}

function renderChatBubble(msg) {
  const role = msg.role || 'user';
  const kind = msg.kind || 'message';
  const isSystem = kind === 'system';
  const isAssistant = role === 'assistant';
  const senderName = msg.sender || msg.assistantName || (isAssistant ? 'Captain' : 'You');
  const text = msg.text || msg.fullText || msg.content || '';
  const time = msg.createdAt || msg.timestamp;
  const timeStr = time ? formatMessageTime(time) : '';
  const metadata = msg.metadata || {};
  const imagePaths = metadata.imagePaths || [];

  if (isSystem) {
    return `
      <div class="cc-message cc-message-system">
        <div class="cc-message-text">${escapeHtml(text)}</div>
        ${timeStr ? `<div class="cc-message-time">${escapeHtml(timeStr)}</div>` : ''}
      </div>
    `;
  }

  const hasImages = imagePaths.length > 0;
  const hasText = text && !text.startsWith('[image:');
  const bubbleClass = isAssistant ? 'cc-message-assistant' : 'cc-message-user';
  return `
    <div class="cc-message ${bubbleClass}">
      <div class="cc-message-sender">${escapeHtml(senderName)}</div>
      ${hasText ? `<div class="cc-message-text cc-markdown">${renderMarkdown(text)}</div>` : ''}
      ${hasImages ? renderImageGrid(imagePaths) : ''}
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

function updateOrAppendStreamingMessage(msg) {
  const chatMessages = document.getElementById('chatMessages');
  const streamingBubble = chatMessages.querySelector('.cc-message-streaming');

  if (streamingBubble) {
    const textEl = streamingBubble.querySelector('.cc-message-text');
    if (textEl) textEl.innerHTML = renderMarkdown(msg.text || msg.fullText || msg.content || '');
    scrollChatToBottom();
  } else {
    const noMsgs = chatMessages.querySelector('.cc-chat-no-messages');
    if (noMsgs) noMsgs.remove();

    const senderName = msg.sender?.id || msg.sender || 'Captain';
    const text = msg.text || msg.fullText || msg.content || '';
    const bubbleHtml = `
      <div class="cc-message cc-message-assistant cc-message-streaming">
        <div class="cc-message-sender">${escapeHtml(senderName)}</div>
        <div class="cc-message-text cc-markdown">${renderMarkdown(text)}</div>
        <div class="cc-message-time" style="font-style: italic; opacity: 0.6;">streaming...</div>
      </div>
    `;
    const div = document.createElement('div');
    div.innerHTML = bubbleHtml;
    chatMessages.appendChild(div.firstElementChild);
    scrollChatToBottom();
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !state.activeThreadId) return;

  input.value = '';
  input.style.height = 'auto';

  // Optimistic append
  appendChatMessage({
    role: 'user',
    sender: 'You',
    text: text,
    createdAt: new Date().toISOString(),
  });

  try {
    await apiPost('/api/message', {
      thread_id: state.activeThreadId,
      text: text,
      assistantId: 'captain',
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

// ── New Thread Modal ──────────────────────────────────────────

async function openNewThreadModal() {
  const modal = document.getElementById('newThreadModal');
  const errorEl = document.getElementById('newThreadError');
  const titleInput = document.getElementById('threadTitle');
  const submitBtn = document.getElementById('newThreadSubmitBtn');

  errorEl.style.display = 'none';
  titleInput.value = '';
  submitBtn.disabled = false;
  submitBtn.textContent = 'Create Thread';

  // Load agents for participant picker
  const picker = document.getElementById('participantPicker');
  picker.innerHTML = '<span class="cc-participant-picker-empty">Loading agents...</span>';

  try {
    const data = await apiCall('/api/agents');
    const agents = data.agents || [];
    if (agents.length === 0) {
      picker.innerHTML = '<span class="cc-participant-picker-empty">No agents available</span>';
    } else {
      picker.innerHTML = agents.map(agent => {
        const initial = (agent.name || agent.id || '?').charAt(0).toUpperCase();
        // Captain is selected by default
        const selected = agent.id === 'captain' ? 'selected' : '';
        return `
          <div class="cc-participant-chip ${selected}" data-agent-id="${escapeHtml(agent.id)}" data-agent-name="${escapeHtml(agent.name || agent.id)}">
            <span class="cc-chip-avatar">${escapeHtml(initial)}</span>
            <span>${escapeHtml(agent.name || agent.id)}</span>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    picker.innerHTML = '<span class="cc-participant-picker-empty">Failed to load agents</span>';
  }

  modal.style.display = 'flex';
  titleInput.focus();
}

function closeNewThreadModal() {
  document.getElementById('newThreadModal').style.display = 'none';
}

async function submitNewThread(e) {
  e.preventDefault();
  const titleInput = document.getElementById('threadTitle');
  const errorEl = document.getElementById('newThreadError');
  const submitBtn = document.getElementById('newThreadSubmitBtn');

  const title = titleInput.value.trim();
  if (!title) return;

  const selectedChips = document.querySelectorAll('#participantPicker .cc-participant-chip.selected');
  const participants = Array.from(selectedChips).map(chip => ({
    participantType: 'assistant',
    participantId: chip.dataset.agentId,
  }));

  errorEl.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating...';

  try {
    const result = await apiPost('/api/threads', { title, participants });
    const newThread = result.thread || result;
    closeNewThreadModal();
    await loadThreadsData();
    if (newThread && newThread.id) {
      selectThread(newThread.id);
    }
  } catch (err) {
    console.error('Failed to create thread:', err);
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Thread';
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

    case 'thread_message': {
      // Unified persisted message event — all messages come through cc msg send
      const msg = event.payload || event;
      const msgThreadId = msg.threadId || msg.thread_id;
      if (msgThreadId && msgThreadId === state.activeThreadId && state.activeTab === 'threads') {
        const senderType = msg.sender?.type || (msg.role === 'assistant' ? 'assistant' : 'user');
        const senderId = msg.sender?.id || msg.senderName || '';
        // Don't duplicate user messages we optimistically appended from this UI
        if (senderType === 'user' && msg.source === 'webui') break;
        appendChatMessage({
          role: senderType === 'user' ? 'user' : 'assistant',
          kind: msg.kind || 'message',
          sender: senderId === 'system' ? 'System' : senderId,
          content: msg.content,
          metadata: msg.metadata,
          createdAt: msg.createdAt,
        });
      } else if (msgThreadId && msgThreadId !== state.activeThreadId) {
        // Mark non-active thread as unread and update sidebar
        state.unreadThreads[msgThreadId] = true;
        if (state.activeTab === 'threads') {
          renderThreadSidebar(state.threads);
        }
      }
      break;
    }

    case 'ui_message_sent': {
      // Legacy — kept for backwards compat, no-op (thread_message handles it)
      break;
    }

    case 'outbound_message':
    case 'assistant_text': {
      // Agent raw output — captain bar preview only, not rendered in threads.
      // Agents post to threads via cc msg send → thread_message events.
      const msg = event.payload || event;
      const text = msg.text || msg.content || '';
      if (text) {
        const agentName = msg.agentId || 'Captain';
        const preview = text.length > 120 ? text.slice(0, 120) + '...' : text;
        updateCaptainBar(`[${agentName}] ${preview}`);
      }
      break;
    }

    case 'claude_result': {
      // Turn complete — metadata only
      break;
    }

    case 'task_created':
    case 'task_updated':
    case 'task_completed':
      if (state.activeTab === 'board' || state.activeTab === 'metrics') {
        loadTabData(state.activeTab);
      }
      // Tasks auto-create threads, so refresh thread list when on threads tab
      if (state.activeTab === 'threads') {
        loadThreadsData();
      }
      break;

    case 'agent_created':
    case 'agent_updated':
    case 'agent_archived':
      if (state.activeTab === 'team') {
        loadTeamData();
      }
      break;

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

// Close modal/panel on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.agentDetailId) {
      closeAgentDetail();
    } else {
      closeNewProjectModal();
    }
  }
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

// Project selection via header dropdown
dom.projectSelect.addEventListener('change', () => {
  const projectId = dom.projectSelect.value;
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

// Team card click — open agent detail panel
dom.teamGrid.addEventListener('click', (e) => {
  const card = e.target.closest('.cc-team-card-clickable');
  if (!card) return;
  const agentId = card.dataset.agentId;
  if (agentId) {
    openAgentDetail(agentId);
  }
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

// Chat input — Enter to send, Shift+Enter for new line
const chatInput = document.getElementById('chatInput');
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

// New thread button
document.getElementById('newThreadBtn').addEventListener('click', () => {
  openNewThreadModal();
});

// New Thread modal
document.getElementById('newThreadCloseBtn').addEventListener('click', closeNewThreadModal);
document.getElementById('newThreadModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeNewThreadModal();
});
document.getElementById('newThreadForm').addEventListener('submit', submitNewThread);
document.getElementById('participantPicker').addEventListener('click', (e) => {
  const chip = e.target.closest('.cc-participant-chip');
  if (chip) chip.classList.toggle('selected');
});

// Board card click — navigate to task thread, or paginate Done column
document.getElementById('boardColumns').addEventListener('click', (e) => {
  // Handle prev/next pagination in Done column
  const pageBtn = e.target.closest('.cc-board-page-btn');
  if (pageBtn && !pageBtn.disabled) {
    const dir = pageBtn.dataset.dir;
    if (dir === 'prev') state.donePage = Math.max(0, state.donePage - 1);
    else if (dir === 'next') state.donePage++;
    if (state._lastBoardTasks) renderBoard(state._lastBoardTasks);
    return;
  }

  const card = e.target.closest('.cc-board-card[data-thread-id]');
  if (!card) return;
  const threadId = card.dataset.threadId;
  if (threadId) {
    showTab('threads');
    selectThread(threadId);
  }
});

// Header button handlers
document.getElementById('settingsBtn').addEventListener('click', () => {
  alert('Settings panel coming soon. Configuration will be available in a future release.');
});

document.getElementById('chatBtn').addEventListener('click', () => {
  if (state.selectedProjectId) {
    showTab('threads');
  }
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
  // Restore tab and thread from localStorage before loading projects
  const savedTab = localStorage.getItem('cc-activeTab');
  if (savedTab && ['team', 'board', 'ops', 'threads', 'metrics'].includes(savedTab)) {
    state.activeTab = savedTab;
  }
  const savedThreadId = localStorage.getItem('cc-activeThreadId');
  if (savedThreadId) {
    state.activeThreadId = savedThreadId;
  }

  await loadProjects();
})();

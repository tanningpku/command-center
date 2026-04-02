// ================================================================
// Command Center — Application Logic
// ================================================================

// ── Auth ─────────────────────────────────────────────────────────

function getAuthToken() {
  return localStorage.getItem('cc-token') || '';
}

function setAuthToken(token) {
  localStorage.setItem('cc-token', token);
  // Also set as cookie for SSE (EventSource can't set headers)
  document.cookie = `cc-token=${encodeURIComponent(token)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

function clearAuthToken() {
  localStorage.removeItem('cc-token');
  document.cookie = 'cc-token=; path=/; max-age=0';
}

function showLoginScreen() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.querySelector('.cc-shell').style.display = 'none';
  document.getElementById('loginPassword').focus();
}

function hideLoginScreen() {
  document.getElementById('loginScreen').style.display = 'none';
  document.querySelector('.cc-shell').style.display = '';
}

function handle401() {
  clearAuthToken();
  showLoginScreen();
  // Close SSE
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  // Stop health polling
  stopHealthPoll();
}

// ── State ────────────────────────────────────────────────────────

const state = {
  projects: [],
  selectedProjectId: null,
  activeTab: 'home',
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
  boardFilters: { search: '', state: '', priority: '', assignee: '' },
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
  dashboardContainer: document.getElementById('dashboardContainer'),
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
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (state.selectedProjectId) {
    headers['X-Project-Id'] = state.selectedProjectId;
  }
  const res = await fetch(path, { headers });
  if (res.status === 401) { handle401(); throw new Error('Unauthorized'); }
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
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (state.selectedProjectId) {
    headers['X-Project-Id'] = state.selectedProjectId;
  }
  const res = await fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 401) { handle401(); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Make a PATCH API call through the gateway.
 */
async function apiPatch(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (state.selectedProjectId) {
    headers['X-Project-Id'] = state.selectedProjectId;
  }
  const res = await fetch(path, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 401) { handle401(); throw new Error('Unauthorized'); }
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
  const headers = {};
  const token = getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch('/api/registry', { headers });
  if (res.status === 401) { handle401(); throw new Error('Unauthorized'); }
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

  // Reset project-specific state
  state._projectUsesTasks = false;
  state.teamData = [];
  state.boardFilters = { search: '', state: '', priority: '', assignee: '' };
  document.getElementById('boardSearch').value = '';
  document.getElementById('boardFilterState').value = '';
  document.getElementById('boardFilterPriority').value = '';
  document.getElementById('boardFilterAssignee').value = '';

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
  // Stop health polling when leaving health tab
  if (state.activeTab === 'health' && tabName !== 'health') {
    stopHealthPoll();
  }

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
    case 'home':
      await loadDashboardData();
      break;
    case 'team':
      await loadTeamData();
      break;
    case 'board':
      await loadBoardData();
      break;
    case 'threads':
      await loadThreadsData();
      break;
    case 'health':
      await loadHealthData();
      break;
  }
}

// ── Home Tab (Dashboard) ────────────────────────────────────────

async function loadDashboardData() {
  if (!state.selectedProjectId) return;

  dom.dashboardContainer.innerHTML = `<div class="cc-loading">Loading dashboard...</div>`;

  try {
    const data = await apiCall('/api/dashboard');
    const blocks = data.blocks || [];
    renderDashboard(blocks);
  } catch (err) {
    const is404 = err.message && (err.message.includes('404') || err.message.includes('not found') || err.message.includes('Not Found'));
    if (is404) {
      dom.dashboardContainer.innerHTML = `
        <div class="cc-dashboard-empty">
          <div class="cc-empty-icon">H</div>
          <h2>Dashboard</h2>
          <p>No dashboard configured yet. Captain will populate this once the project is active.</p>
        </div>
      `;
    } else {
      console.error('Failed to load dashboard:', err);
      dom.dashboardContainer.innerHTML = `
        <div class="cc-dashboard-empty">
          <div class="cc-empty-icon">H</div>
          <h2>Dashboard</h2>
          <p>Unable to load dashboard: ${escapeHtml(err.message)}</p>
        </div>
      `;
    }
  }
}

function renderDashboard(blocks) {
  if (!blocks || blocks.length === 0) {
    dom.dashboardContainer.innerHTML = `
      <div class="cc-dashboard-empty">
        <div class="cc-empty-icon">H</div>
        <h2>Dashboard</h2>
        <p>No dashboard content yet.</p>
      </div>
    `;
    return;
  }

  dom.dashboardContainer.innerHTML = blocks.map(block => renderDashboardBlock(block)).join('');
}

function renderDashboardBlock(block) {
  switch (block.type) {
    case 'hero':    return renderHeroBlock(block);
    case 'stats':   return renderStatsBlock(block);
    case 'alert':   return renderAlertBlock(block);
    case 'activity': return renderActivityBlock(block);
    case 'list':    return renderListBlock(block);
    case 'section': return renderSectionBlock(block);
    case 'agents':  return renderAgentsBlock(block);
    default:        return '';
  }
}

function heroStatusColor(status) {
  const colors = {
    healthy: 'var(--cc-green)',
    warning: 'var(--cc-yellow)',
    critical: 'var(--cc-red)',
    info: 'var(--cc-accent)',
  };
  return colors[status] || 'var(--cc-accent)';
}

function renderHeroBlock(block) {
  const color = heroStatusColor(block.status);
  return `
    <div class="cc-dash-hero" style="border-left-color: ${color}">
      <div class="cc-dash-hero-status" style="color: ${color}">${escapeHtml(block.status || '')}</div>
      <div class="cc-dash-hero-title">${escapeHtml(block.title || '')}</div>
      ${block.subtitle ? `<div class="cc-dash-hero-subtitle">${escapeHtml(block.subtitle)}</div>` : ''}
    </div>
  `;
}

function renderStatsBlock(block) {
  const items = block.items || [];
  return `
    <div class="cc-dash-stats">
      ${items.map(item => {
        const trend = item.trend;
        let trendHtml = '';
        if (trend === 'up') trendHtml = '<span class="cc-dash-stat-trend cc-trend-up">&#9650;</span>';
        else if (trend === 'down') trendHtml = '<span class="cc-dash-stat-trend cc-trend-down">&#9660;</span>';
        return `
          <div class="cc-dash-stat-card">
            <div class="cc-dash-stat-value">${escapeHtml(String(item.value ?? ''))}</div>
            <div class="cc-dash-stat-label">${escapeHtml(item.label || '')}${trendHtml}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function alertLevelColor(level) {
  const colors = {
    info: 'var(--cc-accent)',
    warning: 'var(--cc-yellow)',
    error: 'var(--cc-red)',
  };
  return colors[level] || 'var(--cc-accent)';
}

function alertLevelBg(level) {
  const bgs = {
    info: 'var(--cc-accent-bg)',
    warning: 'var(--cc-yellow-bg)',
    error: 'var(--cc-red-bg)',
  };
  return bgs[level] || 'var(--cc-accent-bg)';
}

function renderAlertBlock(block) {
  const color = alertLevelColor(block.level);
  const bg = alertLevelBg(block.level);
  return `
    <div class="cc-dash-alert" style="border-left-color: ${color}; background: ${bg}; color: ${color}">
      ${block.title ? `<div class="cc-dash-alert-title">${escapeHtml(block.title)}</div>` : ''}
      <div class="cc-dash-alert-message">${escapeHtml(block.message || '')}</div>
    </div>
  `;
}

function renderActivityBlock(block) {
  const items = block.items || [];
  return `
    <div class="cc-dash-activity">
      ${block.title ? `<div class="cc-dash-block-title">${escapeHtml(block.title)}</div>` : ''}
      <div class="cc-dash-activity-list">
        ${items.map(item => `
          <div class="cc-dash-activity-item">
            <span class="cc-dash-activity-dot"></span>
            <span class="cc-dash-activity-text">${escapeHtml(item.text || '')}</span>
            ${item.time ? `<span class="cc-dash-activity-time">${escapeHtml(item.time)}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function listItemStateBadge(state) {
  if (!state) return '';
  const stateClasses = {
    created: 'grey', assigned: 'grey', in_progress: 'blue',
    in_review: 'yellow', qa: 'yellow', blocked: 'red',
    done: 'green', cancelled: 'grey',
  };
  const cls = stateClasses[state] || 'grey';
  const label = state.replace(/_/g, ' ');
  return `<span class="cc-task-badge cc-task-badge-${escapeHtml(cls)}">${escapeHtml(label)}</span>`;
}

function renderListBlock(block) {
  const items = block.items || [];
  return `
    <div class="cc-dash-list">
      ${block.title ? `<div class="cc-dash-block-title">${escapeHtml(block.title)}</div>` : ''}
      <div class="cc-dash-list-items">
        ${items.map(item => `
          <div class="cc-dash-list-item">
            <span class="cc-dash-list-item-text">${escapeHtml(item.text || item.title || '')}</span>
            ${item.state ? listItemStateBadge(item.state) : ''}
            ${item.assignee ? `<span class="cc-dash-list-assignee">${escapeHtml(item.assignee)}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderSectionBlock(block) {
  const content = block.content || '';
  return `
    <div class="cc-dash-section">
      ${block.title ? `<div class="cc-dash-block-title">${escapeHtml(block.title)}</div>` : ''}
      <div class="cc-dash-section-body cc-markdown">${renderMarkdown(content)}</div>
    </div>
  `;
}

function renderAgentsBlock(block) {
  const agents = block.agents || [];
  return `
    <div class="cc-dash-agents">
      ${block.title ? `<div class="cc-dash-block-title">${escapeHtml(block.title)}</div>` : ''}
      <div class="cc-dash-agents-grid">
        ${agents.map(agent => {
          const initial = (agent.name || agent.id || '?').charAt(0).toUpperCase();
          const isOnline = agent.status === 'active' || agent.status === 'online';
          const statusClass = isOnline ? 'cc-status-online' : 'cc-status-offline';
          return `
            <div class="cc-dash-agent-card">
              <div class="cc-avatar cc-avatar-agent" style="width:32px;height:32px;font-size:13px;">${escapeHtml(initial)}</div>
              <div class="cc-dash-agent-info">
                <div class="cc-dash-agent-name">${escapeHtml(agent.name || agent.id || '')}</div>
                ${agent.role ? `<div class="cc-dash-agent-role">${escapeHtml(agent.role)}</div>` : ''}
              </div>
              <span class="cc-status-dot ${statusClass}"></span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ── Team Tab ─────────────────────────────────────────────────────

async function loadTeamData() {
  if (!state.selectedProjectId) return;

  dom.teamGrid.innerHTML = `<div class="cc-loading">Loading team...</div>`;

  try {
    const data = await apiCall('/api/assistants');
    const assistants = data.assistants || data || [];
    state.teamData = assistants;
    populateBoardAssigneeFilter();
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

// Reverse mapping: board column → target task state (for drag-and-drop)
const COLUMN_TO_TASK_STATE = {
  'Backlog': 'created',
  'In Progress': 'in_progress',
  'In Review': 'in_review',
  'Done': 'done',
};

function populateBoardAssigneeFilter() {
  const select = document.getElementById('boardFilterAssignee');
  const current = select.value;
  const agents = state.teamData || [];
  select.innerHTML = '<option value="">All assignees</option>' +
    agents.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}</option>`).join('');
  select.value = current;
  // If previous selection is no longer valid, reset filter state
  if (select.value !== current) {
    state.boardFilters.assignee = '';
  }
}

async function loadBoardData() {
  if (!state.selectedProjectId) return;

  // Ensure assignee filter is populated
  if (!state.teamData || state.teamData.length === 0) {
    try {
      const data = await apiCall('/api/assistants');
      state.teamData = data.assistants || data || [];
    } catch { /* ignore — filter will just be empty */ }
  }
  populateBoardAssigneeFilter();

  dom.boardColumns.innerHTML = `<div class="cc-loading">Loading board...</div>`;

  try {
    // Build query params from filters
    const params = new URLSearchParams();
    const f = state.boardFilters;
    if (f.search) params.set('search', f.search);
    if (f.state) params.set('state', f.state);
    if (f.priority) params.set('priority', f.priority);
    if (f.assignee) params.set('assignee', f.assignee);
    const qs = params.toString();

    // Try tasks first — if tasks exist, render task-based board
    const taskData = await apiCall('/api/tasks' + (qs ? '?' + qs : ''));
    const tasks = taskData.tasks || [];

    if (tasks.length > 0) {
      state._projectUsesTasks = true;
    }
    if (tasks.length > 0 || (qs && state._projectUsesTasks)) {
      // Render task-based board (even if empty when filters are active)
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
    <div class="cc-board-card${threadId ? ' cc-board-card-clickable' : ''}" draggable="true" data-task-id="${escapeHtml(task.id)}" ${threadId ? `data-thread-id="${escapeHtml(threadId)}"` : ''}>
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

// ── Health Tab ──────────────────────────────────────────────────

let _healthPollTimer = null;
let _healthFetching = false;

function stopHealthPoll() {
  if (_healthPollTimer) {
    clearInterval(_healthPollTimer);
    _healthPollTimer = null;
  }
}

function startHealthPoll() {
  stopHealthPoll();
  _healthPollTimer = setInterval(() => {
    if (state.activeTab === 'health') loadHealthData(true);
  }, 10000);
}

async function loadHealthData(silent) {
  const container = document.getElementById('healthContainer');
  if (!container) return;
  if (_healthFetching) return;

  if (!silent) {
    container.innerHTML = '<div class="cc-loading">Loading health data...</div>';
  }

  _healthFetching = true;
  try {
    const data = await apiCall('/api/health');
    renderHealth(data);
  } catch (err) {
    if (!silent) {
      container.innerHTML = `
        <div class="cc-health-error">
          <div class="cc-empty-icon">+</div>
          <h3>Health Unavailable</h3>
          <p>Unable to load health data: ${escapeHtml(err.message)}</p>
          <p style="font-size: 12px; color: var(--cc-text-faint);">The health endpoint may not be deployed yet (T-65).</p>
        </div>
      `;
    }
  } finally {
    _healthFetching = false;
  }
  // Don't restart polling if we've been logged out (handle401 stops polling)
  if (getAuthToken()) startHealthPoll();
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function healthStatusColor(status) {
  const colors = {
    healthy: 'var(--cc-green)',
    degraded: 'var(--cc-yellow)',
    unhealthy: 'var(--cc-red)',
  };
  return colors[status] || 'var(--cc-text-muted)';
}

function bridgeStatusColor(status) {
  const colors = {
    ready: 'var(--cc-green)',
    connecting: 'var(--cc-yellow)',
    restarting: 'var(--cc-yellow)',
    disconnected: 'var(--cc-red)',
    stuck: 'var(--cc-red)',
    stopped: 'var(--cc-text-muted)',
  };
  return colors[status] || 'var(--cc-text-muted)';
}

function renderHealth(data) {
  const container = document.getElementById('healthContainer');
  if (!container) return;

  const status = data.status || 'unknown';
  const statusColor = healthStatusColor(status);
  const uptime = formatUptime(data.uptime_seconds);
  const mem = data.memory || {};
  const sse = data.sse || {};
  const projects = data.projects || {};
  const errorsLastHour = data.errors_last_hour ?? '--';

  // System status banner
  let html = `
    <div class="cc-health-banner" style="border-left-color: ${statusColor}">
      <div class="cc-health-banner-row">
        <div class="cc-health-banner-status">
          <span class="cc-health-dot" style="background: ${statusColor}"></span>
          <span class="cc-health-status-label" style="color: ${statusColor}">${escapeHtml(status.toUpperCase())}</span>
        </div>
        <span class="cc-health-uptime">Uptime: ${escapeHtml(uptime)}</span>
      </div>
      <div class="cc-health-banner-row cc-health-banner-meta">
        <span>Memory: ${mem.rss_mb ?? '--'}MB RSS / ${mem.heap_used_mb ?? '--'}MB Heap</span>
        <span>Requests: ${data.request_count ?? '--'}</span>
        <span>Errors (1h): ${errorsLastHour}</span>
      </div>
    </div>
  `;

  // Bridges per project
  for (const [projectId, project] of Object.entries(projects)) {
    const bridges = project.bridges || {};
    const bridgeEntries = Object.entries(bridges);

    html += `<div class="cc-health-section-title">Bridges — ${escapeHtml(projectId)}</div>`;
    html += '<div class="cc-health-bridges">';

    if (bridgeEntries.length === 0) {
      html += '<div class="cc-health-empty">No bridges found</div>';
    }

    for (const [agentId, bridge] of bridgeEntries) {
      const bStatus = bridge.status || 'unknown';
      const bColor = bridgeStatusColor(bStatus);
      const bUptime = formatUptime(bridge.uptime_seconds);
      const lastActivity = bridge.last_activity_at ? timeAgo(bridge.last_activity_at) : '--';
      const restarts = bridge.restart_count ?? 0;
      const lastReason = bridge.last_restart_reason;
      const isReady = bridge.ready || bStatus === 'ready';
      const isStopped = bStatus === 'stopped' || bStatus === 'disconnected';

      html += `
        <div class="cc-health-bridge-card">
          <div class="cc-health-bridge-header">
            <div class="cc-health-bridge-info">
              <span class="cc-health-dot" style="background: ${bColor}"></span>
              <span class="cc-health-bridge-name">${escapeHtml(agentId)}</span>
              <span class="cc-health-bridge-status" style="color: ${bColor}">${escapeHtml(bStatus.toUpperCase())}</span>
            </div>
            <div class="cc-health-bridge-actions">
              ${isStopped ? `<button class="cc-health-btn cc-health-btn-start" data-action="start" data-agent="${escapeHtml(agentId)}" data-project="${escapeHtml(projectId)}">Start</button>` : ''}
              <button class="cc-health-btn cc-health-btn-restart" data-action="restart" data-agent="${escapeHtml(agentId)}" data-project="${escapeHtml(projectId)}">Restart</button>
              ${!isStopped ? `<button class="cc-health-btn cc-health-btn-stop" data-action="stop" data-agent="${escapeHtml(agentId)}" data-project="${escapeHtml(projectId)}">Stop</button>` : ''}
            </div>
          </div>
          <div class="cc-health-bridge-meta">
            <span>Uptime: ${escapeHtml(bUptime)}</span>
            <span>Last activity: ${escapeHtml(lastActivity)}</span>
            <span>Restarts: ${restarts}</span>
            ${lastReason ? `<span>Last reason: ${escapeHtml(lastReason)}</span>` : ''}
            ${bridge.pid ? `<span>PID: ${bridge.pid}</span>` : ''}
          </div>
        </div>
      `;
    }

    html += '</div>';

    // Stores
    const stores = project.stores || {};
    const storeEntries = Object.entries(stores);
    if (storeEntries.length > 0) {
      html += '<div class="cc-health-section-title">Stores</div>';
      html += '<div class="cc-health-stores">';
      for (const [name, store] of storeEntries) {
        const storeOk = store.ok;
        const storeColor = storeOk ? 'var(--cc-green)' : 'var(--cc-red)';
        const storeLabel = storeOk ? 'OK' : 'ERROR';
        const sizeKb = store.size_kb != null ? `${store.size_kb}KB` : '';
        html += `
          <div class="cc-health-store-card">
            <span class="cc-health-dot" style="background: ${storeColor}"></span>
            <span class="cc-health-store-name">${escapeHtml(name)}.db</span>
            <span class="cc-health-store-status" style="color: ${storeColor}">${storeLabel}</span>
            ${sizeKb ? `<span class="cc-health-store-size">${sizeKb}</span>` : ''}
          </div>
        `;
      }
      html += '</div>';
    }
  }

  // SSE status
  html += '<div class="cc-health-section-title">SSE</div>';
  html += `
    <div class="cc-health-sse">
      <span>${sse.connected_clients ?? '--'} clients connected</span>
      <span>Buffer: ${sse.buffer_size ?? '--'} / ${sse.buffer_capacity ?? '--'}</span>
    </div>
  `;

  // Global actions
  html += `
    <div class="cc-health-actions">
      <button class="cc-health-btn cc-health-btn-cleanup" id="healthCleanupBtn">Clean Up Stale Processes</button>
      <button class="cc-health-btn cc-health-btn-restart-gw" id="healthRestartGwBtn">Restart Gateway</button>
    </div>
  `;

  container.innerHTML = html;
}

async function healthBridgeAction(action, agentId, projectId) {
  const actionLabels = { restart: 'Restarting', stop: 'Stopping', start: 'Starting' };
  const label = actionLabels[action] || action;

  if (!confirm(`${label} bridge "${agentId}" (project: ${projectId || state.selectedProjectId})?`)) return;

  // Temporarily set project context to the bridge's project for the API call
  const prevProject = state.selectedProjectId;
  if (projectId) state.selectedProjectId = projectId;
  try {
    await apiPost(`/api/health/bridges/${encodeURIComponent(agentId)}/${action}`, {});
    await loadHealthData(true);
  } catch (err) {
    alert(`Failed to ${action} bridge: ${err.message}`);
  } finally {
    state.selectedProjectId = prevProject;
  }
}

async function healthCleanup() {
  if (!confirm('Clean up stale Claude processes?')) return;
  try {
    const result = await apiPost('/api/health/cleanup', {});
    const killed = result.killed ?? 0;
    alert(`Cleaned up ${killed} stale process${killed !== 1 ? 'es' : ''}.`);
    await loadHealthData(true);
  } catch (err) {
    alert(`Cleanup failed: ${err.message}`);
  }
}

async function healthRestartGateway() {
  if (!confirm('Restart the entire gateway? The page will reload after restart.')) return;
  try {
    await apiPost('/api/restart', {});
    // Gateway will restart; wait a moment then reload
    setTimeout(() => window.location.reload(), 3000);
  } catch (err) {
    alert(`Restart failed: ${err.message}`);
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
        ${!isPinned ? `<button class="cc-thread-delete-btn" data-thread-delete-id="${escapeHtml(thread.id)}" title="Delete thread">&#x2715;</button>` : ''}
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

async function deleteThread(threadId) {
  const thread = state.threads.find(t => t.id === threadId);
  const title = thread ? (thread.title || thread.id) : threadId;
  if (!confirm(`Delete thread "${title}"? This action cannot be undone.`)) return;

  try {
    const headers = {};
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (state.selectedProjectId) headers['X-Project-Id'] = state.selectedProjectId;
    const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE', headers });
    if (res.status === 401) { handle401(); throw new Error('Unauthorized'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    state.threads = state.threads.filter(t => t.id !== threadId);
    if (state.activeThreadId === threadId) {
      state.activeThreadId = null;
      localStorage.removeItem('cc-activeThreadId');
      showChatEmptyState();
    }
    // Update thread count
    const threadCount = document.getElementById('threadCount');
    if (threadCount) {
      threadCount.textContent = `${state.threads.length} thread${state.threads.length !== 1 ? 's' : ''}`;
    }
    // Show empty state if no threads remain
    if (state.threads.length === 0) {
      const threadList = document.getElementById('threadList');
      if (threadList) {
        threadList.innerHTML = `<div class="cc-thread-sidebar-empty"><p>No threads yet.</p></div>`;
      }
      showChatEmptyState();
    } else {
      renderThreadSidebar(state.threads);
    }
  } catch (err) {
    alert('Failed to delete thread: ' + (err.message || err));
  }
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

  try {
    let url = '/api/events';
    if (state.selectedProjectId) {
      url += `?projectId=${encodeURIComponent(state.selectedProjectId)}`;
    }
    const sseToken = getAuthToken();
    if (sseToken) {
      url += (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(sseToken)}`;
    }
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

    case 'dashboard_update':
      if (state.activeTab === 'home') {
        loadDashboardData();
      }
      break;

    case 'task_created':
    case 'task_updated':
    case 'task_completed':
      if (state.activeTab === 'board') {
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

    case 'health_changed':
    case 'bridge_status_changed':
    case 'bridge_stopped':
    case 'bridge_started':
    case 'bridge_restarted':
    case 'cleanup_completed':
      if (state.activeTab === 'health') {
        loadHealthData(true);
      }
      break;

    case 'project_deleted': {
      const deletedId = event.payload?.projectId;
      if (deletedId) handleProjectDeleted(deletedId);
      break;
    }

    case 'project_created':
      // Reload project list to pick up the new project
      loadProjects();
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

// Escape key handled by unified keyboard shortcut system below

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
    const postHeaders = { 'Content-Type': 'application/json' };
    const tok = getAuthToken();
    if (tok) postHeaders['Authorization'] = `Bearer ${tok}`;
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: postHeaders,
      body: JSON.stringify({ directory, captainName }),
    });
    if (res.status === 401) { handle401(); return; }
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

// ── Delete Project ──────────────────────────────────────────────

let _deleteTargetProjectId = null;

function openDeleteProjectModal() {
  if (!state.selectedProjectId) return;
  const project = state.projects.find(p => p.id === state.selectedProjectId);
  if (!project) return;

  _deleteTargetProjectId = project.id;
  const modal = document.getElementById('deleteProjectModal');
  const errorEl = document.getElementById('deleteProjectError');
  errorEl.style.display = 'none';
  document.getElementById('deleteProjectName').textContent = project.name || project.id;
  modal.style.display = 'flex';
}

function closeDeleteProjectModal() {
  document.getElementById('deleteProjectModal').style.display = 'none';
  _deleteTargetProjectId = null;
}

document.getElementById('deleteProjectBtn').addEventListener('click', openDeleteProjectModal);
document.getElementById('deleteProjectCloseBtn').addEventListener('click', closeDeleteProjectModal);
document.getElementById('deleteProjectCancelBtn').addEventListener('click', closeDeleteProjectModal);

// Close on overlay click
document.getElementById('deleteProjectModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeDeleteProjectModal();
});

document.getElementById('deleteProjectConfirmBtn').addEventListener('click', async () => {
  const projectId = _deleteTargetProjectId;
  if (!projectId) return;

  const errorEl = document.getElementById('deleteProjectError');
  const confirmBtn = document.getElementById('deleteProjectConfirmBtn');

  errorEl.style.display = 'none';
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Deleting...';

  try {
    const headers = {};
    const tok = getAuthToken();
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers,
    });
    if (res.status === 401) { handle401(); return; }
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // Success — close modal, remove project from list
    closeDeleteProjectModal();
    handleProjectDeleted(projectId);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Delete Project';
  }
});

function handleProjectDeleted(projectId) {
  // Close delete modal if it's targeting this project (e.g. deleted by another client)
  if (_deleteTargetProjectId === projectId) closeDeleteProjectModal();

  state.projects = state.projects.filter(p => p.id !== projectId);

  if (state.selectedProjectId === projectId) {
    state.selectedProjectId = null;
    localStorage.removeItem('cc-selectedProjectId');
    state.activeThreadId = null;
    localStorage.removeItem('cc-activeThreadId');

    stopHealthPoll();

    if (state.projects.length > 0) {
      renderProjectList();
      selectProject(state.projects[0].id);
    } else {
      renderProjectList();
      dom.tabNav.style.display = 'none';
      dom.emptyState.style.display = 'flex';
      // Hide all tab content
      document.querySelectorAll('.cc-tab-content').forEach(el => {
        el.style.display = 'none';
      });
      // Reconnect SSE in global scope to receive project_created events
      connectSSE();
    }
  } else {
    renderProjectList();
  }
}

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

// Thread sidebar click — select or delete a thread
document.getElementById('threadList').addEventListener('click', (e) => {
  const deleteBtn = e.target.closest('.cc-thread-delete-btn');
  if (deleteBtn) {
    e.stopPropagation();
    const threadId = deleteBtn.dataset.threadDeleteId;
    if (threadId) deleteThread(threadId);
    return;
  }
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

// ── Board Filters ───────────────────────────────────────────────
let _boardSearchTimer = null;

document.getElementById('boardSearch').addEventListener('input', (e) => {
  clearTimeout(_boardSearchTimer);
  _boardSearchTimer = setTimeout(() => {
    state.boardFilters.search = e.target.value.trim();
    loadBoardData();
  }, 300);
});

document.getElementById('boardFilterState').addEventListener('change', (e) => {
  state.boardFilters.state = e.target.value;
  loadBoardData();
});

document.getElementById('boardFilterPriority').addEventListener('change', (e) => {
  state.boardFilters.priority = e.target.value;
  loadBoardData();
});

document.getElementById('boardFilterAssignee').addEventListener('change', (e) => {
  state.boardFilters.assignee = e.target.value;
  loadBoardData();
});

document.getElementById('boardFilterClear').addEventListener('click', () => {
  state.boardFilters = { search: '', state: '', priority: '', assignee: '' };
  document.getElementById('boardSearch').value = '';
  document.getElementById('boardFilterState').value = '';
  document.getElementById('boardFilterPriority').value = '';
  document.getElementById('boardFilterAssignee').value = '';
  loadBoardData();
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

// ── Board Drag-and-Drop ─────────────────────────────────────────
const boardEl = document.getElementById('boardColumns');

boardEl.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.cc-board-card[data-task-id]');
  if (!card) return;
  card.classList.add('cc-board-card-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.taskId);
});

boardEl.addEventListener('dragend', (e) => {
  const card = e.target.closest('.cc-board-card');
  if (card) card.classList.remove('cc-board-card-dragging');
  // Remove all column highlights
  boardEl.querySelectorAll('.cc-board-column-dragover').forEach(
    col => col.classList.remove('cc-board-column-dragover')
  );
});

boardEl.addEventListener('dragover', (e) => {
  const column = e.target.closest('.cc-board-column');
  if (!column) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  // Highlight only the hovered column
  boardEl.querySelectorAll('.cc-board-column-dragover').forEach(
    col => col !== column && col.classList.remove('cc-board-column-dragover')
  );
  column.classList.add('cc-board-column-dragover');
});

boardEl.addEventListener('dragleave', (e) => {
  const column = e.target.closest('.cc-board-column');
  if (!column) return;
  // Only remove if we actually left this column (not entering a child)
  if (!column.contains(e.relatedTarget)) {
    column.classList.remove('cc-board-column-dragover');
  }
});

boardEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  boardEl.querySelectorAll('.cc-board-column-dragover').forEach(
    col => col.classList.remove('cc-board-column-dragover')
  );

  const column = e.target.closest('.cc-board-column');
  if (!column) return;

  const taskId = e.dataTransfer.getData('text/plain');
  if (!taskId) return;

  const targetCol = column.dataset.col;
  const newState = COLUMN_TO_TASK_STATE[targetCol];
  if (!newState) return;

  // Skip if card is already in this column's state
  const currentTask = (state._lastBoardTasks || []).find(t => t.id === taskId);
  if (currentTask && TASK_STATE_TO_COLUMN[currentTask.state] === targetCol) return;

  try {
    await apiPatch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      state: newState,
      actor: 'user',
    });
    // SSE will trigger board refresh automatically
  } catch (err) {
    console.error('Failed to update task state:', err);
  }
});

// Health tab — bridge action buttons, cleanup, restart gateway (all delegated)
document.getElementById('healthContainer').addEventListener('click', (e) => {
  const btn = e.target.closest('.cc-health-btn');
  if (!btn) return;
  const action = btn.dataset.action;
  const agentId = btn.dataset.agent;
  const projectId = btn.dataset.project;
  if (action && agentId) {
    healthBridgeAction(action, agentId, projectId);
  } else if (btn.id === 'healthCleanupBtn') {
    healthCleanup();
  } else if (btn.id === 'healthRestartGwBtn') {
    healthRestartGateway();
  }
});
document.getElementById('healthRefreshBtn').addEventListener('click', () => loadHealthData());

// Header button handlers
document.getElementById('settingsBtn').addEventListener('click', () => {
  alert('Settings panel coming soon. Configuration will be available in a future release.');
});

document.getElementById('chatBtn').addEventListener('click', () => {
  if (state.selectedProjectId) {
    showTab('threads');
  }
});

// ── Keyboard Shortcuts ──────────────────────────────────────────

let _lastKey = null;
let _lastKeyTime = 0;
const CHORD_TIMEOUT = 500; // ms window for g+X chords

function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function getSelectedListIndex(container) {
  if (!container) return -1;
  const items = container.querySelectorAll('[data-kb-selectable]');
  for (let i = 0; i < items.length; i++) {
    if (items[i].classList.contains('cc-kb-selected')) return i;
  }
  return -1;
}

function selectListItem(container, index) {
  if (!container) return;
  const items = container.querySelectorAll('[data-kb-selectable]');
  if (items.length === 0) return;
  const clamped = Math.max(0, Math.min(index, items.length - 1));
  items.forEach(el => el.classList.remove('cc-kb-selected'));
  items[clamped].classList.add('cc-kb-selected');
  items[clamped].scrollIntoView({ block: 'nearest' });
}

function getActiveListContainer() {
  if (state.activeTab === 'threads') {
    return document.getElementById('threadList');
  }
  if (state.activeTab === 'team') {
    return document.getElementById('teamGrid');
  }
  return null;
}

function openSelectedItem() {
  const container = getActiveListContainer();
  if (!container) return;
  const selected = container.querySelector('.cc-kb-selected');
  if (selected) selected.click();
}

function showShortcutHelp() {
  let overlay = document.getElementById('shortcutHelpOverlay');
  if (overlay) {
    overlay.style.display = 'flex';
    return;
  }

  overlay = document.createElement('div');
  overlay.id = 'shortcutHelpOverlay';
  overlay.className = 'cc-modal-overlay';
  overlay.innerHTML = `
    <div class="cc-modal cc-shortcut-modal">
      <div class="cc-modal-header">
        <h3>Keyboard Shortcuts</h3>
        <button class="cc-modal-close" id="shortcutHelpClose">&times;</button>
      </div>
      <div class="cc-modal-body cc-shortcut-body">
        <div class="cc-shortcut-group">
          <div class="cc-shortcut-group-title">Navigation</div>
          <div class="cc-shortcut-row"><kbd>g</kbd> <kbd>h</kbd><span>Go to Home</span></div>
          <div class="cc-shortcut-row"><kbd>g</kbd> <kbd>t</kbd><span>Go to Team</span></div>
          <div class="cc-shortcut-row"><kbd>g</kbd> <kbd>b</kbd><span>Go to Board</span></div>
          <div class="cc-shortcut-row"><kbd>g</kbd> <kbd>r</kbd><span>Go to Threads</span></div>
          <div class="cc-shortcut-row"><kbd>g</kbd> <kbd>x</kbd><span>Go to Health</span></div>
        </div>
        <div class="cc-shortcut-group">
          <div class="cc-shortcut-group-title">Lists</div>
          <div class="cc-shortcut-row"><kbd>j</kbd><span>Move down</span></div>
          <div class="cc-shortcut-row"><kbd>k</kbd><span>Move up</span></div>
          <div class="cc-shortcut-row"><kbd>Enter</kbd><span>Open selected</span></div>
        </div>
        <div class="cc-shortcut-group">
          <div class="cc-shortcut-group-title">General</div>
          <div class="cc-shortcut-row"><kbd>Esc</kbd><span>Close panel / modal</span></div>
          <div class="cc-shortcut-row"><kbd>?</kbd><span>Show this help</span></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const closeBtn = document.getElementById('shortcutHelpClose');
  closeBtn.addEventListener('click', () => overlay.style.display = 'none');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
}

function hideShortcutHelp() {
  const overlay = document.getElementById('shortcutHelpOverlay');
  if (overlay) overlay.style.display = 'none';
}

document.addEventListener('keydown', (e) => {
  const key = e.key;

  // Escape always works — even when input is focused or help overlay is open
  if (key === 'Escape') {
    const helpOverlay = document.getElementById('shortcutHelpOverlay');
    if (helpOverlay && helpOverlay.style.display !== 'none') {
      hideShortcutHelp();
    } else if (state.agentDetailId) {
      closeAgentDetail();
    } else {
      closeNewProjectModal();
      closeNewThreadModal();
      closeDeleteProjectModal();
    }
    return;
  }

  // Ctrl/Cmd + number shortcuts — work even when input is focused
  if ((e.ctrlKey || e.metaKey) && key >= '1' && key <= '5') {
    e.preventDefault();
    const tabs = ['home', 'team', 'board', 'threads', 'health'];
    const idx = parseInt(key, 10) - 1;
    if (tabs[idx] && state.selectedProjectId) {
      showTab(tabs[idx]);
    }
    return;
  }

  // All other shortcuts: skip when typing in an input
  if (isInputFocused()) return;

  // Skip shortcuts when help overlay is visible
  const helpOverlay = document.getElementById('shortcutHelpOverlay');
  if (helpOverlay && helpOverlay.style.display !== 'none') return;

  const now = Date.now();

  // ? — show shortcut help
  if (key === '?') {
    e.preventDefault();
    showShortcutHelp();
    return;
  }

  // Don't handle shortcuts with modifiers (except the ones above)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // g+X chord navigation
  if (_lastKey === 'g' && (now - _lastKeyTime) < CHORD_TIMEOUT && state.selectedProjectId) {
    const chordMap = { h: 'home', t: 'team', b: 'board', r: 'threads', x: 'health' };
    const tab = chordMap[key];
    if (tab) {
      e.preventDefault();
      showTab(tab);
      _lastKey = null;
      return;
    }
  }

  // Track key for chord
  if (key === 'g') {
    _lastKey = 'g';
    _lastKeyTime = now;
    return;
  }

  // j/k — navigate lists
  if (key === 'j' || key === 'k') {
    const container = getActiveListContainer();
    if (!container) { _lastKey = null; return; }

    // Mark items as selectable if not already
    const selectableSelector = state.activeTab === 'threads' ? '.cc-thread-card' : '.cc-team-card';
    const items = container.querySelectorAll(selectableSelector);
    items.forEach(el => el.setAttribute('data-kb-selectable', ''));

    const current = getSelectedListIndex(container);
    const next = key === 'j' ? current + 1 : current - 1;
    selectListItem(container, next);
    e.preventDefault();
    _lastKey = null;
    return;
  }

  // Enter — open selected item
  if (key === 'Enter') {
    openSelectedItem();
    _lastKey = null;
    return;
  }

  _lastKey = null;
});

// ── Login Form ──────────────────────────────────────────────────

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  const submitBtn = document.getElementById('loginSubmitBtn');

  errorEl.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || 'Invalid password');
    }

    setAuthToken(data.token);
    hideLoginScreen();
    document.getElementById('loginPassword').value = '';
    startApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
    document.getElementById('loginPassword').select();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';
  }
});

// ── Logout ──────────────────────────────────────────────────────

document.getElementById('logoutBtn').addEventListener('click', () => {
  handle401();
});

// ── Initialization ───────────────────────────────────────────────

async function startApp() {
  // Restore tab and thread from localStorage before loading projects
  const savedTab = localStorage.getItem('cc-activeTab');
  if (savedTab && ['home', 'team', 'board', 'threads', 'health'].includes(savedTab)) {
    state.activeTab = savedTab;
  }
  const savedThreadId = localStorage.getItem('cc-activeThreadId');
  if (savedThreadId) {
    state.activeThreadId = savedThreadId;
  }

  await loadProjects();
}

(async function init() {
  // Check if server requires auth
  try {
    const res = await fetch('/api/auth/check');
    const data = await res.json();
    if (!data.authEnabled) {
      // No password set — skip login entirely
      hideLoginScreen();
      startApp();
      return;
    }
  } catch (e) {
    // If check fails, fall through to token check
  }
  // Auth is enabled — check for existing token
  if (getAuthToken()) {
    hideLoginScreen();
    startApp();
  } else {
    showLoginScreen();
  }
})();

/**
 * Dashboard Generator for Command Center
 *
 * Generates dashboard blocks from live project data (tasks, agents, threads).
 * Captain calls generateDashboardBlocks() and POSTs the result to /api/dashboard,
 * optionally enriching with brief/recommendation text before posting.
 */

import type { TaskStore, Task, TaskState } from "./task-store.js";
import type { AgentStore, Agent } from "./agent-store.js";
import type { ThreadStore, Thread, ChatMessage } from "./thread-store.js";

/* ------------------------------------------------------------------ */
/*  Block types (matches design spec from T-107)                       */
/* ------------------------------------------------------------------ */

export interface BriefBlock {
  type: "brief";
  status: "healthy" | "warning" | "critical";
  message: string;
  timestamp: string;
}

export interface AttentionItem {
  category: "blocked" | "stale" | "agent-issue" | "waiting";
  taskId?: string;
  title: string;
  context: string;
  assignee?: string;
  age: string;
  urgency: "high" | "medium";
}

export interface AttentionBlock {
  type: "attention";
  items: AttentionItem[];
}

export interface ThreadWaitingItem {
  threadId: string;
  threadName: string;
  preview: string;
  unread: number;
  age: string;
}

export interface ThreadWaitingBlock {
  type: "thread_waiting";
  items: ThreadWaitingItem[];
}

export interface RecommendationBlock {
  type: "recommendation";
  text: string;
}

export interface InflightItem {
  taskId: string;
  title: string;
  status: "active" | "review" | "qa";
  note: string;
  agent: string;
}

export interface InflightBlock {
  type: "inflight";
  items: InflightItem[];
}

export interface ShippedItem {
  taskId: string;
  title: string;
  completedAt: string;
  agent: string;
}

export interface ShippedBlock {
  type: "shipped";
  label: string;
  items: ShippedItem[];
}

export interface TeamPulseAgent {
  agentId: string;
  name: string;
  status: "online" | "idle" | "offline" | "error";
  currentTask: string | null;
}

export interface TeamPulseBlock {
  type: "team_pulse";
  agents: TeamPulseAgent[];
}

export interface StatsBlock {
  type: "stats";
  items: { label: string; value: number; color?: string }[];
}

export type DashboardBlock =
  | BriefBlock
  | AttentionBlock
  | ThreadWaitingBlock
  | RecommendationBlock
  | InflightBlock
  | ShippedBlock
  | TeamPulseBlock
  | StatsBlock;

/* ------------------------------------------------------------------ */
/*  Bridge status info (subset of ClaudeBridge.getHealthInfo())         */
/* ------------------------------------------------------------------ */

export interface BridgeStatusInfo {
  agent_id: string;
  status: string;           // ready | connecting | restarting | disconnected | stopped
  last_activity_at: string;
  last_response_at: string | null;
}

/* ------------------------------------------------------------------ */
/*  Helper: human-readable age string                                  */
/* ------------------------------------------------------------------ */

function formatAge(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/* ------------------------------------------------------------------ */
/*  Generator                                                          */
/* ------------------------------------------------------------------ */

export interface GeneratorInput {
  taskStore: TaskStore;
  agentStore: AgentStore;
  threadStore: ThreadStore;
  bridgeStatuses: BridgeStatusInfo[];
  userId?: string;  // for unread counts (defaults to "user")
}

/**
 * Generate all data-driven dashboard blocks from live project state.
 *
 * Returns blocks that Captain can use directly or enrich with brief/recommendation
 * text before POSTing to /api/dashboard.
 *
 * Note: `brief` and `recommendation` blocks are NOT auto-generated here because
 * they require Captain's natural language synthesis. This function returns the raw
 * data blocks; Captain adds brief + recommendation on top.
 */
export function generateDashboardBlocks(input: GeneratorInput): DashboardBlock[] {
  const { taskStore, agentStore, threadStore, bridgeStatuses, userId = "user" } = input;
  const blocks: DashboardBlock[] = [];

  // ── Gather data ──
  const allTasks = taskStore.list({ limit: 500 });
  const agents = agentStore.list();
  const threads = threadStore.listThreads();
  const unreadCounts = threadStore.getUnreadCounts(userId);

  // ── 1. Attention block (blocked tasks, stale tasks, agent issues) ──
  const attentionItems = buildAttentionItems(allTasks, bridgeStatuses);
  if (attentionItems.length > 0) {
    blocks.push({ type: "attention", items: attentionItems });
  }

  // ── 2. Thread waiting block (threads with unread messages for user) ──
  const waitingItems = buildThreadWaitingItems(threads, threadStore, unreadCounts, userId);
  if (waitingItems.length > 0) {
    blocks.push({ type: "thread_waiting", items: waitingItems });
  }

  // ── 3. Inflight block (in_progress, in_review, qa tasks) ──
  const inflightItems = buildInflightItems(allTasks);
  if (inflightItems.length > 0) {
    blocks.push({ type: "inflight", items: inflightItems });
  }

  // ── 4. Shipped block (recently completed tasks) ──
  const shippedBlock = buildShippedBlock(allTasks, taskStore);
  if (shippedBlock) {
    blocks.push(shippedBlock);
  }

  // ── 5. Team pulse block (agent status grid) ──
  const teamPulse = buildTeamPulseBlock(agents, allTasks, bridgeStatuses);
  blocks.push(teamPulse);

  return blocks;
}

/**
 * Compute a project health level from live data.
 * Captain can use this to set the brief block's status color.
 */
export function computeHealthLevel(input: GeneratorInput): "healthy" | "warning" | "critical" {
  const { taskStore, bridgeStatuses } = input;
  const allTasks = taskStore.list({ limit: 500 });

  const blockedCount = allTasks.filter((t) => t.state === "blocked").length;
  const crashedAgents = bridgeStatuses.filter((b) => b.status === "disconnected" || b.status === "stopped").length;

  // Check for stale tasks (assigned/in_progress with no update for 48h+)
  const staleCount = countStaleTasks(allTasks, taskStore);

  if (blockedCount >= 3 || crashedAgents >= 2 || (blockedCount >= 1 && crashedAgents >= 1)) {
    return "critical";
  }
  if (blockedCount >= 1 || crashedAgents >= 1 || staleCount >= 2) {
    return "warning";
  }
  return "healthy";
}

/* ------------------------------------------------------------------ */
/*  Block builders                                                     */
/* ------------------------------------------------------------------ */

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

function countStaleTasks(tasks: Task[], taskStore: TaskStore): number {
  const now = Date.now();
  let count = 0;
  for (const t of tasks) {
    if (t.state === "assigned" || t.state === "in_progress") {
      const lastEvent = taskStore.getLastEventTime(t.id);
      const refTime = lastEvent ?? t.updatedAt;
      if (now - new Date(refTime).getTime() > STALE_THRESHOLD_MS) {
        count++;
      }
    }
  }
  return count;
}

function buildAttentionItems(tasks: Task[], bridgeStatuses: BridgeStatusInfo[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  const now = Date.now();

  // Blocked tasks
  for (const t of tasks) {
    if (t.state === "blocked") {
      const blockedSince = t.updatedAt;
      const ageMs = now - new Date(blockedSince).getTime();
      items.push({
        category: "blocked",
        taskId: t.id,
        title: t.title,
        context: t.latestUpdate ?? `Blocked — assigned to ${t.assignee ?? "unassigned"}`,
        assignee: t.assignee,
        age: formatAge(blockedSince),
        urgency: ageMs > 12 * 60 * 60 * 1000 ? "high" : "medium",
      });
    }
  }

  // Stale tasks (assigned/in_progress with no activity for 48h+)
  for (const t of tasks) {
    if (t.state === "assigned" || t.state === "in_progress") {
      const refTime = t.updatedAt;
      const ageMs = now - new Date(refTime).getTime();
      if (ageMs > STALE_THRESHOLD_MS) {
        items.push({
          category: "stale",
          taskId: t.id,
          title: t.title,
          context: `Assigned to ${t.assignee ?? "unassigned"} ${formatAge(t.createdAt)} ago, no updates since ${formatAge(refTime)}`,
          assignee: t.assignee,
          age: formatAge(refTime),
          urgency: ageMs > 4 * 24 * 60 * 60 * 1000 ? "high" : "medium",
        });
      }
    }
  }

  // Agent issues (crashed/disconnected bridges)
  for (const b of bridgeStatuses) {
    if (b.status === "disconnected" || b.status === "stopped") {
      items.push({
        category: "agent-issue",
        title: `${b.agent_id} process ${b.status}`,
        context: `Last activity: ${formatAge(b.last_activity_at)} ago. May need manual restart.`,
        assignee: b.agent_id,
        age: formatAge(b.last_activity_at),
        urgency: "high",
      });
    }
  }

  // Sort: high urgency first, then by age (oldest first)
  items.sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency === "high" ? -1 : 1;
    return 0; // preserve insertion order within same urgency
  });

  return items;
}

function buildThreadWaitingItems(
  threads: Thread[],
  threadStore: ThreadStore,
  unreadCounts: Map<string, number>,
  _userId: string,
): ThreadWaitingItem[] {
  const items: ThreadWaitingItem[] = [];

  for (const thread of threads) {
    const unread = unreadCounts.get(thread.id) ?? 0;
    if (unread === 0) continue;

    // Get last message for preview
    const recentMessages = threadStore.getMessages(thread.id, { limit: 1 });
    const lastMsg = recentMessages[recentMessages.length - 1];
    if (!lastMsg) continue;

    // Only surface threads where the last message is from an agent (not from the user)
    if (lastMsg.role === "user" && lastMsg.sender === _userId) continue;

    const preview = lastMsg.content.length > 120
      ? lastMsg.content.slice(0, 117) + "..."
      : lastMsg.content;

    items.push({
      threadId: thread.id,
      threadName: thread.title,
      preview: lastMsg.sender ? `${lastMsg.sender}: ${preview}` : preview,
      unread,
      age: formatAge(lastMsg.createdAt),
    });
  }

  // Sort by most unread first, then most recent
  items.sort((a, b) => b.unread - a.unread);

  return items.slice(0, 5); // Cap at 5 threads
}

function buildInflightItems(tasks: Task[]): InflightItem[] {
  const inflightStates: Record<string, "active" | "review" | "qa"> = {
    in_progress: "active",
    in_review: "review",
    qa: "qa",
  };

  const items: InflightItem[] = [];
  for (const t of tasks) {
    const mappedStatus = inflightStates[t.state];
    if (!mappedStatus) continue;

    items.push({
      taskId: t.id,
      title: t.title,
      status: mappedStatus,
      note: t.latestUpdate ?? "",
      agent: t.assignee ?? "unassigned",
    });
  }

  // Sort: active first, then review, then qa
  const statusOrder: Record<string, number> = { active: 0, review: 1, qa: 2 };
  items.sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3));

  return items;
}

function buildShippedBlock(tasks: Task[], taskStore: TaskStore): ShippedBlock | null {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const oneWeekMs = 7 * oneDayMs;

  const doneTasks = tasks.filter((t) => t.state === "done");

  // Find tasks completed today
  const todayItems: ShippedItem[] = [];
  const weekItems: ShippedItem[] = [];

  for (const t of doneTasks) {
    const completedAt = t.updatedAt; // updatedAt reflects when state changed to done
    const ageMs = now - new Date(completedAt).getTime();

    if (ageMs <= oneDayMs) {
      todayItems.push({
        taskId: t.id,
        title: t.title,
        completedAt,
        agent: t.assignee ?? "unknown",
      });
    } else if (ageMs <= oneWeekMs) {
      weekItems.push({
        taskId: t.id,
        title: t.title,
        completedAt,
        agent: t.assignee ?? "unknown",
      });
    }
  }

  // Sort by most recently completed first
  const sortByRecent = (a: ShippedItem, b: ShippedItem) =>
    new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime();

  if (todayItems.length > 0) {
    todayItems.sort(sortByRecent);
    return { type: "shipped", label: "Shipped Today", items: todayItems };
  }

  if (weekItems.length > 0) {
    weekItems.sort(sortByRecent);
    return { type: "shipped", label: "Shipped This Week", items: weekItems.slice(0, 5) };
  }

  return null;
}

function buildTeamPulseBlock(
  agents: Agent[],
  tasks: Task[],
  bridgeStatuses: BridgeStatusInfo[],
): TeamPulseBlock {
  const bridgeMap = new Map(bridgeStatuses.map((b) => [b.agent_id, b]));

  // Build a map of agent → current active task
  const activeTaskMap = new Map<string, string>();
  for (const t of tasks) {
    if (!t.assignee) continue;
    if (t.state === "in_progress" || t.state === "in_review" || t.state === "qa") {
      // First active task wins (tasks are sorted by priority)
      if (!activeTaskMap.has(t.assignee)) {
        const stateLabel = t.state === "in_progress" ? "active" : t.state === "in_review" ? "review" : "QA";
        activeTaskMap.set(t.assignee, `${t.id} ${stateLabel}`);
      }
    }
  }

  const pulseAgents: TeamPulseAgent[] = [];
  for (const agent of agents) {
    if (agent.id === "captain") continue; // Captain doesn't appear in team pulse

    const bridge = bridgeMap.get(agent.id);
    let status: TeamPulseAgent["status"] = "offline";

    if (bridge) {
      if (bridge.status === "ready") {
        status = activeTaskMap.has(agent.id) ? "online" : "idle";
      } else if (bridge.status === "connecting" || bridge.status === "restarting") {
        status = "idle";
      } else if (bridge.status === "disconnected" || bridge.status === "stopped") {
        status = "error";
      }
    } else {
      // No bridge — agent is offline
      status = "offline";
    }

    const currentTask = activeTaskMap.get(agent.id) ?? null;

    pulseAgents.push({
      agentId: agent.id,
      name: agent.name,
      status,
      currentTask,
    });
  }

  return { type: "team_pulse", agents: pulseAgents };
}

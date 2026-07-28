const mongoose = require('mongoose');
const SaasCrmWorkspace = require('../../models/SaasCrmWorkspace');
const SaasCrmOpportunity = require('../../models/SaasCrmOpportunity');
const SaasCrmTask = require('../../models/SaasCrmTask');

const DEFAULT_STAGES = [
  { id: 'new', name: 'New', order: 0, color: '#64748b', isClosed: false },
  { id: 'contacted', name: 'Contacted', order: 1, color: '#0ea5e9', isClosed: false },
  { id: 'quoted', name: 'Quoted', order: 2, color: '#8b5cf6', isClosed: false },
  { id: 'won', name: 'Won', order: 3, color: '#10b981', isClosed: true },
  { id: 'lost', name: 'Lost', order: 4, color: '#ef4444', isClosed: true },
];

const VERTICAL_TEMPLATES = {
  salon: {
    stages: [
      { id: 'new', name: 'New enquiry', order: 0, color: '#64748b', isClosed: false },
      { id: 'consultation', name: 'Consultation booked', order: 1, color: '#0ea5e9', isClosed: false },
      { id: 'quote', name: 'Quote sent', order: 2, color: '#8b5cf6', isClosed: false },
      { id: 'won', name: 'Booked client', order: 3, color: '#10b981', isClosed: true },
      { id: 'lost', name: 'Lost', order: 4, color: '#ef4444', isClosed: true },
    ],
    tasks: ['Call lead in 30 mins', 'Send service menu + pricing', 'Follow up next day'],
  },
  restaurant: {
    stages: [
      { id: 'new', name: 'New lead', order: 0, color: '#64748b', isClosed: false },
      { id: 'contacted', name: 'Contacted', order: 1, color: '#0ea5e9', isClosed: false },
      { id: 'offer', name: 'Offer sent', order: 2, color: '#8b5cf6', isClosed: false },
      { id: 'won', name: 'Booked / ordered', order: 3, color: '#10b981', isClosed: true },
      { id: 'lost', name: 'Lost', order: 4, color: '#ef4444', isClosed: true },
    ],
    tasks: ['Send menu and specials', 'Check dietary needs', 'Confirm booking time'],
  },
  retail: {
    stages: [
      { id: 'new', name: 'New lead', order: 0, color: '#64748b', isClosed: false },
      { id: 'qualified', name: 'Qualified', order: 1, color: '#0ea5e9', isClosed: false },
      { id: 'offer', name: 'Offer shared', order: 2, color: '#8b5cf6', isClosed: false },
      { id: 'won', name: 'Sale closed', order: 3, color: '#10b981', isClosed: true },
      { id: 'lost', name: 'Lost', order: 4, color: '#ef4444', isClosed: true },
    ],
    tasks: ['Share product link', 'Follow up on cart intent', 'Offer upsell bundle'],
  },
  services: {
    stages: [
      { id: 'new', name: 'New enquiry', order: 0, color: '#64748b', isClosed: false },
      { id: 'discovery', name: 'Discovery', order: 1, color: '#0ea5e9', isClosed: false },
      { id: 'proposal', name: 'Proposal sent', order: 2, color: '#8b5cf6', isClosed: false },
      { id: 'won', name: 'Signed', order: 3, color: '#10b981', isClosed: true },
      { id: 'lost', name: 'Lost', order: 4, color: '#ef4444', isClosed: true },
    ],
    tasks: ['Book discovery call', 'Send proposal PDF', 'Follow up after 48h'],
  },
};

function safeStageId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 40);
}

async function ensureWorkspace(clientId) {
  let workspace = await SaasCrmWorkspace.findOne({ client_id: clientId });
  if (workspace) return workspace;
  workspace = await SaasCrmWorkspace.create({
    client_id: clientId,
    stages: DEFAULT_STAGES,
    vertical: 'generic',
  });
  return workspace;
}

function mapOpportunity(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    stageId: doc.stage_id,
    status: doc.status,
    priority: doc.priority,
    value: doc.value || 0,
    currency: doc.currency || 'ZAR',
    customerName: doc.customer_name || '',
    customerEmail: doc.customer_email || '',
    customerPhone: doc.customer_phone || '',
    source: doc.source || '',
    notes: doc.notes || '',
    ownerName: doc.owner_name || '',
    linkedOrderId: doc.linked_order_id || '',
    linkedBookingId: doc.linked_booking_id || '',
    createdAt: doc.created_at || null,
    updatedAt: doc.updated_at || null,
    closedAt: doc.closed_at || null,
  };
}

function mapTask(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    description: doc.description || '',
    status: doc.status,
    priority: doc.priority,
    dueAt: doc.due_at || null,
    reminderAt: doc.reminder_at || null,
    reminderStatus: doc.reminder_status || 'pending',
    reminderSentAt: doc.reminder_sent_at || null,
    assigneeName: doc.assignee_name || '',
    linkedOpportunityId: doc.linked_opportunity_id ? String(doc.linked_opportunity_id) : '',
    linkedOrderId: doc.linked_order_id || '',
    linkedBookingId: doc.linked_booking_id || '',
    customerName: doc.customer_name || '',
    customerEmail: doc.customer_email || '',
    customerPhone: doc.customer_phone || '',
    createdAt: doc.created_at || null,
    updatedAt: doc.updated_at || null,
    completedAt: doc.completed_at || null,
  };
}

async function getBoard(clientId) {
  const workspace = await ensureWorkspace(clientId);
  const [opportunities, tasks] = await Promise.all([
    SaasCrmOpportunity.find({ client_id: clientId }).sort({ updated_at: -1 }).limit(400),
    SaasCrmTask.find({ client_id: clientId, status: 'open' }).sort({ due_at: 1, created_at: -1 }).limit(200),
  ]);

  const stages = (workspace.stages || DEFAULT_STAGES).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const mappedOpps = opportunities.map(mapOpportunity);
  const grouped = Object.fromEntries(stages.map((s) => [s.id, []]));
  for (const opp of mappedOpps) {
    if (!grouped[opp.stageId]) grouped[opp.stageId] = [];
    grouped[opp.stageId].push(opp);
  }

  const overdueTasks = tasks.filter((t) => t.due_at && new Date(t.due_at).getTime() < Date.now()).length;

  return {
    workspace: {
      vertical: workspace.vertical || 'generic',
      reminderSettings: workspace.reminderSettings || {},
      templateAppliedAt: workspace.templateAppliedAt || null,
    },
    stages,
    opportunitiesByStage: grouped,
    tasks: tasks.map(mapTask),
    stats: {
      openOpportunities: mappedOpps.filter((o) => o.status === 'open').length,
      wonOpportunities: mappedOpps.filter((o) => o.status === 'won').length,
      overdueTasks,
    },
  };
}

async function listTasks(clientId, { status = '', due = '' } = {}) {
  const query = { client_id: clientId };
  if (status) query.status = String(status);
  if (due === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    query.due_at = { $gte: start, $lt: end };
  } else if (due === 'overdue') {
    query.due_at = { $lt: new Date() };
    query.status = 'open';
  } else if (due === 'upcoming') {
    query.due_at = { $gte: new Date() };
    query.status = 'open';
  }

  const tasks = await SaasCrmTask.find(query).sort({ due_at: 1, created_at: -1 }).limit(400);
  return { tasks: tasks.map(mapTask) };
}

async function upsertStages(clientId, stages = []) {
  const workspace = await ensureWorkspace(clientId);
  const normalized = (Array.isArray(stages) ? stages : [])
    .map((stage, idx) => ({
      id: safeStageId(stage.id || stage.name || `stage-${idx + 1}`),
      name: String(stage.name || `Stage ${idx + 1}`).trim().slice(0, 80),
      order: Number(stage.order ?? idx),
      color: String(stage.color || ''),
      isClosed: Boolean(stage.isClosed),
    }))
    .filter((s) => s.id);
  if (!normalized.length) throw new Error('At least one stage is required');
  workspace.stages = normalized;
  await workspace.save();
  return { stages: normalized };
}

async function createOpportunity(clientId, input = {}, actor = {}) {
  const workspace = await ensureWorkspace(clientId);
  const defaultStage = workspace.stages?.[0]?.id || DEFAULT_STAGES[0].id;
  const stageId = safeStageId(input.stage_id || defaultStage);

  const created = await SaasCrmOpportunity.create({
    client_id: clientId,
    title: String(input.title || '').trim(),
    stage_id: stageId,
    status: String(input.status || 'open'),
    priority: String(input.priority || 'medium'),
    value: Number(input.value) || 0,
    currency: String(input.currency || 'ZAR'),
    customer_name: String(input.customer_name || ''),
    customer_email: String(input.customer_email || ''),
    customer_phone: String(input.customer_phone || ''),
    source: String(input.source || ''),
    notes: String(input.notes || ''),
    owner_name: String(input.owner_name || actor.name || ''),
    owner_user_id: String(actor.userId || ''),
    linked_order_id: String(input.linked_order_id || ''),
    linked_booking_id: String(input.linked_booking_id || ''),
    last_activity_at: new Date(),
    closed_at: String(input.status || 'open') === 'open' ? null : new Date(),
  });
  return mapOpportunity(created);
}

async function updateOpportunity(clientId, opportunityId, input = {}) {
  if (!mongoose.isValidObjectId(opportunityId)) throw new Error('Invalid opportunity id');
  const doc = await SaasCrmOpportunity.findOne({ _id: opportunityId, client_id: clientId });
  if (!doc) throw new Error('Opportunity not found');

  if (input.title != null) doc.title = String(input.title).trim().slice(0, 200);
  if (input.stage_id != null) doc.stage_id = safeStageId(input.stage_id || doc.stage_id);
  if (input.priority != null) doc.priority = String(input.priority);
  if (input.status != null) {
    doc.status = String(input.status);
    doc.closed_at = doc.status === 'open' ? null : new Date();
  }
  if (input.value != null) doc.value = Number(input.value) || 0;
  if (input.notes != null) doc.notes = String(input.notes);
  if (input.customer_name != null) doc.customer_name = String(input.customer_name);
  if (input.customer_email != null) doc.customer_email = String(input.customer_email);
  if (input.customer_phone != null) doc.customer_phone = String(input.customer_phone);
  if (input.owner_name != null) doc.owner_name = String(input.owner_name);
  doc.last_activity_at = new Date();
  await doc.save();
  return mapOpportunity(doc);
}

async function createTask(clientId, input = {}, actor = {}) {
  const task = await SaasCrmTask.create({
    client_id: clientId,
    title: String(input.title || '').trim(),
    description: String(input.description || ''),
    status: 'open',
    priority: String(input.priority || 'medium'),
    due_at: input.due_at ? new Date(input.due_at) : null,
    reminder_at: input.reminder_at ? new Date(input.reminder_at) : null,
    reminder_status: 'pending',
    assignee_name: String(input.assignee_name || actor.name || ''),
    assignee_user_id: String(actor.userId || ''),
    linked_opportunity_id: mongoose.isValidObjectId(input.linked_opportunity_id)
      ? input.linked_opportunity_id
      : null,
    linked_order_id: String(input.linked_order_id || ''),
    linked_booking_id: String(input.linked_booking_id || ''),
    customer_name: String(input.customer_name || ''),
    customer_email: String(input.customer_email || ''),
    customer_phone: String(input.customer_phone || ''),
  });
  return mapTask(task);
}

async function updateTask(clientId, taskId, input = {}) {
  if (!mongoose.isValidObjectId(taskId)) throw new Error('Invalid task id');
  const task = await SaasCrmTask.findOne({ _id: taskId, client_id: clientId });
  if (!task) throw new Error('Task not found');

  if (input.title != null) task.title = String(input.title).trim().slice(0, 200);
  if (input.description != null) task.description = String(input.description);
  if (input.priority != null) task.priority = String(input.priority);
  if (input.status != null) {
    task.status = String(input.status);
    if (task.status === 'completed') task.completed_at = new Date();
    if (task.status === 'cancelled') task.cancelled_at = new Date();
  }
  if (input.due_at !== undefined) task.due_at = input.due_at ? new Date(input.due_at) : null;
  if (input.reminder_at !== undefined) task.reminder_at = input.reminder_at ? new Date(input.reminder_at) : null;
  if (input.assignee_name != null) task.assignee_name = String(input.assignee_name);
  if (input.customer_name != null) task.customer_name = String(input.customer_name);
  if (input.customer_email != null) task.customer_email = String(input.customer_email);
  if (input.customer_phone != null) task.customer_phone = String(input.customer_phone);
  if (input.linked_opportunity_id != null) {
    task.linked_opportunity_id = mongoose.isValidObjectId(input.linked_opportunity_id)
      ? input.linked_opportunity_id
      : null;
  }
  if (task.status === 'open') {
    task.reminder_status = 'pending';
    task.reminder_sent_at = null;
  }
  await task.save();
  return mapTask(task);
}

async function applyVerticalTemplate(clientId, vertical, { actorName = '' } = {}) {
  const key = String(vertical || '').toLowerCase();
  const template = VERTICAL_TEMPLATES[key];
  if (!template) throw new Error('Unsupported vertical template');
  const workspace = await ensureWorkspace(clientId);
  workspace.vertical = key;
  workspace.stages = template.stages;
  workspace.templateAppliedAt = new Date();
  await workspace.save();

  const baseDue = new Date();
  const createdTasks = [];
  for (let i = 0; i < template.tasks.length; i += 1) {
    const due = new Date(baseDue.getTime() + (i + 1) * 24 * 60 * 60 * 1000);
    const task = await SaasCrmTask.create({
      client_id: clientId,
      title: template.tasks[i],
      status: 'open',
      priority: i === 0 ? 'high' : 'medium',
      due_at: due,
      reminder_at: new Date(due.getTime() - 30 * 60 * 1000),
      reminder_status: 'pending',
      assignee_name: actorName,
    });
    createdTasks.push(mapTask(task));
  }

  return {
    vertical: workspace.vertical,
    stages: workspace.stages,
    seededTasks: createdTasks,
  };
}

async function getVerticalTemplates() {
  return {
    templates: Object.entries(VERTICAL_TEMPLATES).map(([id, value]) => ({
      id,
      stageCount: value.stages.length,
      starterTasks: value.tasks,
    })),
  };
}

async function exportCsv(clientId, type = 'opportunities') {
  if (type === 'tasks') {
    const tasks = await SaasCrmTask.find({ client_id: clientId }).sort({ created_at: -1 }).limit(1000);
    const rows = [
      'Title,Status,Priority,Due Date,Assignee,Customer,Email,Phone,Opportunity Id',
      ...tasks.map((t) =>
        [
          t.title,
          t.status,
          t.priority,
          t.due_at ? new Date(t.due_at).toISOString() : '',
          t.assignee_name || '',
          t.customer_name || '',
          t.customer_email || '',
          t.customer_phone || '',
          t.linked_opportunity_id ? String(t.linked_opportunity_id) : '',
        ]
          .map((v) => `"${String(v || '').replace(/"/g, '""')}"`)
          .join(',')
      ),
    ];
    return rows.join('\n');
  }

  const opps = await SaasCrmOpportunity.find({ client_id: clientId }).sort({ created_at: -1 }).limit(1000);
  const rows = [
    'Title,Stage,Status,Priority,Value,Currency,Customer,Email,Phone,Owner,Source,Created At',
    ...opps.map((o) =>
      [
        o.title,
        o.stage_id,
        o.status,
        o.priority,
        o.value || 0,
        o.currency || 'ZAR',
        o.customer_name || '',
        o.customer_email || '',
        o.customer_phone || '',
        o.owner_name || '',
        o.source || '',
        o.created_at ? new Date(o.created_at).toISOString() : '',
      ]
        .map((v) => `"${String(v || '').replace(/"/g, '""')}"`)
        .join(',')
    ),
  ];
  return rows.join('\n');
}

async function processRemindersTick({ now = new Date() } = {}) {
  const dueTasks = await SaasCrmTask.find({
    status: 'open',
    reminder_status: 'pending',
    reminder_at: { $ne: null, $lte: now },
  })
    .sort({ reminder_at: 1 })
    .limit(300);

  let processed = 0;
  for (const task of dueTasks) {
    task.reminder_status = 'sent';
    task.reminder_sent_at = new Date();
    await task.save();
    processed += 1;
  }
  return { processed };
}

module.exports = {
  DEFAULT_STAGES,
  getBoard,
  listTasks,
  upsertStages,
  createOpportunity,
  updateOpportunity,
  createTask,
  updateTask,
  applyVerticalTemplate,
  getVerticalTemplates,
  exportCsv,
  processRemindersTick,
};

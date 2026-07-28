const CrmWorkspaceService = require('../../services/saas/CrmWorkspaceService');

async function processCrmTaskReminders() {
  return CrmWorkspaceService.processRemindersTick({});
}

module.exports = { processCrmTaskReminders };

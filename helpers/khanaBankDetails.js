/**
 * Khana business bank account for prepaid credit EFT (no payment gateway).
 * Set via env on Render — never hardcode real account numbers in git.
 */

function bankDetailsConfigured() {
  return Boolean(
    String(process.env.KHANA_BANK_ACCOUNT_NUMBER || '').trim() &&
      String(process.env.KHANA_BANK_ACCOUNT_NAME || process.env.KHANA_BANK_NAME || '').trim()
  );
}

function getBusinessBankDetails() {
  if (!bankDetailsConfigured()) {
    return {
      configured: false,
      bankName: '',
      accountName: '',
      accountNumber: '',
      branchCode: '',
      accountType: '',
      swift: '',
      instructions: '',
    };
  }

  return {
    configured: true,
    bankName: String(process.env.KHANA_BANK_NAME || 'Business bank').trim(),
    accountName: String(
      process.env.KHANA_BANK_ACCOUNT_NAME || process.env.KHANA_BANK_NAME || 'Khana Technologies'
    ).trim(),
    accountNumber: String(process.env.KHANA_BANK_ACCOUNT_NUMBER || '').trim(),
    branchCode: String(process.env.KHANA_BANK_BRANCH_CODE || '').trim(),
    accountType: String(process.env.KHANA_BANK_ACCOUNT_TYPE || 'Business cheque').trim(),
    swift: String(process.env.KHANA_BANK_SWIFT || '').trim(),
    instructions: String(
      process.env.KHANA_BANK_INSTRUCTIONS ||
        'Use the payment reference exactly. Email proof of payment to your Khana contact. Credits are applied after we confirm the deposit.'
    ).trim(),
  };
}

module.exports = {
  bankDetailsConfigured,
  getBusinessBankDetails,
};

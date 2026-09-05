const { LEGAL_ENTITY, PATHS, POLICY_VERSIONS, getDocument } = require('./legalPolicies');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSection(section) {
  const parts = [];
  parts.push(`<section class="clause"><h2>${escapeHtml(section.heading)}</h2>`);
  for (const p of section.paragraphs || []) {
    parts.push(`<p>${escapeHtml(p)}</p>`);
  }
  if (section.bullets?.length) {
    parts.push('<ul>');
    for (const item of section.bullets) {
      parts.push(`<li>${escapeHtml(item)}</li>`);
    }
    parts.push('</ul>');
  }
  for (const p of section.after || []) {
    parts.push(`<p>${escapeHtml(p)}</p>`);
  }
  parts.push('</section>');
  return parts.join('\n');
}

function navLink(href, label, currentPath) {
  const active = href === currentPath ? ' class="active"' : '';
  return `<a href="${escapeHtml(href)}"${active}>${escapeHtml(label)}</a>`;
}

function renderLegalPage(docId) {
  const doc = getDocument(docId);
  if (!doc) return null;

  const body = doc.sections.map(renderSection).join('\n');
  const title = `${doc.title} | ${LEGAL_ENTITY.tradingAs}`;

  return `<!DOCTYPE html>
<html lang="en-ZA">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(doc.title)} for ${LEGAL_ENTITY.name}" />
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      background: #f4f6f8;
      color: #1f2937;
      line-height: 1.55;
    }
    header {
      background: #0f172a;
      color: #f8fafc;
      padding: 1.25rem 1.5rem;
    }
    header .brand { font-family: system-ui, sans-serif; font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; color: #93c5fd; }
    header h1 { margin: 0.35rem 0 0.2rem; font-size: 1.6rem; font-weight: 600; }
    header .meta { font-family: system-ui, sans-serif; font-size: 0.85rem; color: #cbd5e1; }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem 1rem;
      padding: 0.75rem 1.5rem;
      background: #1e293b;
      font-family: system-ui, sans-serif;
      font-size: 0.9rem;
    }
    nav a { color: #e2e8f0; text-decoration: none; }
    nav a.active, nav a:hover { color: #93c5fd; text-decoration: underline; }
    main { max-width: 46rem; margin: 0 auto; padding: 1.5rem; }
    .notice {
      font-family: system-ui, sans-serif;
      font-size: 0.9rem;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      padding: 0.85rem 1rem;
      margin-bottom: 1.5rem;
    }
    .clause { margin-bottom: 1.6rem; }
    h2 { font-size: 1.15rem; margin: 0 0 0.6rem; }
    p, li { font-size: 1rem; }
    ul { padding-left: 1.2rem; }
    footer {
      max-width: 46rem;
      margin: 0 auto 2rem;
      padding: 0 1.5rem;
      font-family: system-ui, sans-serif;
      font-size: 0.8rem;
      color: #64748b;
    }
    @media print {
      header, nav, .notice { break-inside: avoid; }
      nav { display: none; }
      body { background: #fff; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">${escapeHtml(LEGAL_ENTITY.name)}</div>
    <h1>${escapeHtml(doc.title)}</h1>
    <div class="meta">Version ${escapeHtml(doc.version)} · Updated ${escapeHtml(POLICY_VERSIONS.publishedLabel)} · Registration ${escapeHtml(LEGAL_ENTITY.registration)}</div>
  </header>
  <nav>
    ${navLink(PATHS.index, 'Legal', doc.path)}
    ${navLink(PATHS.tos, 'Terms', doc.path)}
    ${navLink(PATHS.aup, 'Acceptable use', doc.path)}
    ${navLink(PATHS.takedown, 'Take-down notices', doc.path)}
    <a href="${escapeHtml(PATHS.privacy)}">Privacy</a>
  </nav>
  <main>
    <p class="notice">These documents apply to merchants who use KhanaConnect. They are published to allocate responsibility for classifiable media under the Films and Publications Act. They are not a substitute for advice from South African counsel. FPB registration numbers and ISPA membership will be shown here only after they are issued.</p>
    ${body}
  </main>
  <footer>
    ${escapeHtml(LEGAL_ENTITY.name)} · ${escapeHtml(LEGAL_ENTITY.registration)} · ${escapeHtml(LEGAL_ENTITY.email)}
  </footer>
</body>
</html>`;
}

function renderLegalIndex() {
  const title = `Legal | ${LEGAL_ENTITY.tradingAs}`;
  return `<!DOCTYPE html>
<html lang="en-ZA">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #f4f6f8; color: #1f2937; }
    header { background: #0f172a; color: #f8fafc; padding: 1.5rem; }
    header .brand { font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; color: #93c5fd; }
    h1 { margin: 0.4rem 0 0; font-size: 1.6rem; }
    main { max-width: 40rem; margin: 0 auto; padding: 1.5rem; }
    a.card {
      display: block;
      background: #fff;
      border: 1px solid #e5e7eb;
      padding: 1rem 1.1rem;
      margin-bottom: 0.75rem;
      color: inherit;
      text-decoration: none;
    }
    a.card:hover { border-color: #2563eb; }
    a.card strong { display: block; margin-bottom: 0.25rem; }
    a.card span { color: #64748b; font-size: 0.9rem; }
  </style>
</head>
<body>
  <header>
    <div class="brand">${escapeHtml(LEGAL_ENTITY.name)}</div>
    <h1>Legal documents</h1>
  </header>
  <main>
    <p>Merchant contract and content rules for KhanaConnect. Accept the current versions when you submit a plan estimate or when you first sign in.</p>
    <a class="card" href="${PATHS.tos}"><strong>Merchant Terms of Service</strong><span>${POLICY_VERSIONS.tos}</span></a>
    <a class="card" href="${PATHS.aup}"><strong>Acceptable Use Policy</strong><span>${POLICY_VERSIONS.aup}</span></a>
    <a class="card" href="${PATHS.takedown}"><strong>Copyright and content take-down notices</strong><span>${POLICY_VERSIONS.takedown}</span></a>
    <a class="card" href="${PATHS.privacy}"><strong>Privacy Policy</strong><span>khanatechnologies.co.za</span></a>
    <p><a href="${PATHS.policiesJson}">Machine-readable versions (JSON)</a></p>
  </main>
</body>
</html>`;
}

module.exports = { escapeHtml, renderLegalPage, renderLegalIndex };

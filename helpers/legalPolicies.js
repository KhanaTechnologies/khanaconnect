const { resolvePublicBaseUrl } = require('./publicBaseUrl');

const LEGAL_ENTITY = {
  name: 'KHANA TECHNOLOGIES (Pty) Ltd',
  tradingAs: 'Khana Technologies / KhanaConnect',
  registration: '2023/559956/07',
  email: 'contact@khanatechnologies.co.za',
  country: 'South Africa',
};

const POLICY_VERSIONS = {
  tos: 'TOS-2026-09-05',
  aup: 'AUP-2026-09-05',
  takedown: 'TDN-2026-09-05',
  publishedAt: '2026-09-05',
  publishedLabel: '5 September 2026',
};

const PATHS = {
  index: '/legal',
  tos: '/terms',
  tosAlias: '/terms-of-service',
  aup: '/aup',
  aupAlias: '/acceptable-use',
  takedown: '/legal/takedown',
  policiesJson: '/legal/policies.json',
  privacy: 'https://khanatechnologies.co.za/privacy-policy',
  ispaTdn: 'https://ispa.org.za/tdn/',
};

function takeDownAgent() {
  const ispaMember = String(process.env.LEGAL_ISPA_MEMBER || '').toLowerCase() === 'true';
  return {
    name: process.env.LEGAL_TAKEDOWN_AGENT_NAME || 'Take-down agent',
    entity: LEGAL_ENTITY.name,
    registration: LEGAL_ENTITY.registration,
    email: process.env.LEGAL_TAKEDOWN_EMAIL || 'contact@khanatechnologies.co.za',
    phone: process.env.LEGAL_TAKEDOWN_PHONE || '',
    address: process.env.LEGAL_TAKEDOWN_ADDRESS || '',
    ispaMember,
  };
}

function legalPageUrl(path) {
  const base = resolvePublicBaseUrl().replace(/\/$/, '');
  return `${base}${path}`;
}

function publicLegalDocuments() {
  return {
    tos: { title: 'Merchant Terms of Service', version: POLICY_VERSIONS.tos, url: legalPageUrl(PATHS.tos) },
    aup: { title: 'Acceptable Use Policy', version: POLICY_VERSIONS.aup, url: legalPageUrl(PATHS.aup) },
    takedown: {
      title: 'Copyright and content take-down notices',
      version: POLICY_VERSIONS.takedown,
      url: legalPageUrl(PATHS.takedown),
    },
    privacy: { title: 'Privacy Policy', url: PATHS.privacy },
  };
}

function currentPolicyVersions() {
  return { tos: POLICY_VERSIONS.tos, aup: POLICY_VERSIONS.aup, takedown: POLICY_VERSIONS.takedown };
}

function publicLegalMeta() {
  const agent = takeDownAgent();
  return {
    entity: LEGAL_ENTITY,
    versions: currentPolicyVersions(),
    publishedAt: POLICY_VERSIONS.publishedAt,
    documents: publicLegalDocuments(),
    takeDownAgent: {
      name: agent.name,
      entity: agent.entity,
      registration: agent.registration,
      email: agent.email,
      phone: agent.phone || null,
      address: agent.address || null,
      ispaMember: agent.ispaMember,
      ispaUrl: PATHS.ispaTdn,
    },
    clickwrap: {
      requiredField: 'acceptedLegalTerms',
      label:
        'I am authorised to bind this business, and I accept the Merchant Terms of Service and Acceptable Use Policy, including the prohibition on unclassified films, adult content, and games, immediate suspension after an FPB or take-down notice, and the FPB indemnity.',
    },
  };
}

const TOS_SECTIONS = [
  {
    heading: '1. Parties and agreement',
    paragraphs: [
      `${LEGAL_ENTITY.name} (Registration ${LEGAL_ENTITY.registration}) ("Khana", "we", "us") provides hosted e-commerce, bookings, and related software ("the Platform") to the business that opens an account ("you", "Merchant").`,
      `These Merchant Terms of Service, together with the Acceptable Use Policy and the take-down notice page, form a binding agreement when you tick the acceptance box, sign an order, submit a partnership estimate, or otherwise use the Platform. If you do not agree, do not use the Platform.`,
      `Version ${POLICY_VERSIONS.tos}. Last updated ${POLICY_VERSIONS.publishedLabel}. Have South African counsel review this document before you rely on it in a dispute.`,
    ],
  },
  {
    heading: '2. What we provide',
    paragraphs: [
      'We provide software and hosting infrastructure so you can operate an online store, take bookings, and use related tools. We are an intermediary and host. We are not your publisher, joint vendor, or commercial online distributor of films, games, or publications.',
      'We do not actively monitor every listing. You are solely responsible for your inventory, media, copy, customers, and compliance with South African law, including the Films and Publications Act 65 of 1996 as amended (the "FP Act"), the Electronic Communications and Transactions Act 25 of 2002 (the "ECT Act"), the Consumer Protection Act, and the Protection of Personal Information Act.',
    ],
  },
  {
    heading: '3. Accounts and authority',
    paragraphs: [
      'The person who accepts these Terms warrants that they are authorised to bind the Merchant. You must keep login credentials confidential and ensure every team member complies with these Terms and the Acceptable Use Policy.',
      'We may provision an account for you after a sales conversation. You must accept the current Terms and Acceptable Use Policy on first login or when we publish a material update. Continued use after notice of a material update is acceptance.',
    ],
  },
  {
    heading: '4. Fees',
    paragraphs: [
      'Fees are as quoted in your partnership estimate, invoice, or dashboard. Unpaid accounts may be suspended. Fees already paid are not refundable where we suspend or terminate under these Terms for your breach or a regulatory notice.',
    ],
  },
  {
    heading: '5. Merchant warranties — media and children',
    paragraphs: [
      'You warrant that you will not use the Platform to host, distribute, or advertise child sexual abuse material, propaganda for war, incitement of imminent violence, or hate speech as contemplated in the FP Act. If you become aware of any such material in your store you will tell us immediately. We will report and preserve evidence as required by law.',
      'If you sell any film, game, or publication, you warrant that you are registered with the Film and Publication Board ("FPB") as a distributor to the extent required, that each title is classified or lawfully exempt, and that you will keep registration and classification records for so long as the title remains listed plus five years.',
      'You will not display or sell XX material, and you will not sell X18 material except from premises and through channels the FP Act permits. The Platform is not a licensed adult premises.',
    ],
  },
  {
    heading: '6. Independent intermediary',
    paragraphs: [
      'We are not your publisher, joint distributor, or commercial online distributor. Nothing in these Terms makes us responsible for classifying merchant media. If a regulator characterises us as an internet service provider or host, you remain solely responsible for your inventory.',
    ],
  },
  {
    heading: '7. Acceptable use',
    paragraphs: [
      `You must comply with the Acceptable Use Policy published at ${PATHS.aup} (version ${POLICY_VERSIONS.aup}). A breach of that policy is a material breach of these Terms.`,
    ],
  },
  {
    heading: '8. Prohibited digital goods and classifiable media',
    paragraphs: [
      '8.1 You may not upload, list, sell, offer for sale, hire, stream, host, transmit, or otherwise distribute, on or through the Platform, any film, video, digital video file, video-on-demand title, interactive computer game, or publication (including adult or sexually explicit audiovisual material) that:',
    ],
    bullets: [
      '(a) is required to be classified under the FP Act and has not been classified, or exempted from classification, by the FPB or by a person lawfully accredited under section 18C of the FP Act; or',
      '(b) is classified XX or is otherwise prohibited from distribution in the Republic; or',
      '(c) you are not lawfully registered or permitted to distribute in the Republic.',
    ],
    after: [
      '8.2 Adult content, films, and games are prohibited on the Platform unless you first give us written evidence, in the form we reasonably require, that (i) the title is classified or lawfully exempt, (ii) you hold any required FPB distributor registration or permit, and (iii) the FPB classification decision and logo will be displayed on the landing page, catalogue listing, and point of sale as required by section 18A of the FP Act. We may refuse that permission entirely.',
      '8.3 You are the "distributor" and, where applicable, the "commercial online distributor" of all classifiable media in your store. We provide hosting and software infrastructure only. We do not classify, endorse, or distribute that media on our own account.',
      '8.4 Breach of this clause is a material breach. We may immediately disable the item, the storefront, or your account under clause 9.',
    ],
  },
  {
    heading: '9. Immediate suspension, blocking and removal',
    paragraphs: [
      '9.1 Without limiting any other right, we may immediately suspend, block, disable, take offline, or permanently delete any storefront, listing, media file, account, domain mapping, or other material on the Platform, in whole or in part, without prior notice to you and without liability to you, if:',
    ],
    bullets: [
      '(a) we receive a notice, complaint, compliance notice, take-down notice, or directive from the Film and Publication Board, the South African Police Service, a court, or any other competent authority relating to your store or content;',
      '(b) we receive a take-down notification under section 77 of the ECT Act, including a notice processed through the Internet Service Providers\' Association (ISPA) once we are a member;',
      '(c) we reasonably believe your store or content is unclassified classifiable media, prohibited content, or otherwise unlawful under the FP Act or any other law; or',
      '(d) you breach the Acceptable Use Policy or clause 8.',
    ],
    after: [
      '9.2 You have no claim against us for loss of profits, data, goodwill, ranking, or any other loss arising from action taken under this clause. We are not obliged to restore a storefront or listing unless a competent authority or a final court order requires it.',
      '9.3 We may preserve copies of the material and your account records as required by law or for the investigation or defence of claims, including the duties in section 27A of the FP Act where they apply to us.',
      '9.4 Fees already paid are not refundable where we act under this clause.',
    ],
  },
  {
    heading: '10. Copyright and content take-down notices',
    paragraphs: [
      `The designated agent, contact details, and procedure are published at ${PATHS.takedown}. We will treat a valid ECT Act section 77 notice and an FPB take-down or compliance notice as grounds for immediate action under clause 9. We may notify you but are not required to obtain your consent first.`,
    ],
  },
  {
    heading: '11. FPB and regulatory indemnity',
    paragraphs: [
      `11.1 You indemnify, defend, and hold harmless ${LEGAL_ENTITY.name} (Registration ${LEGAL_ENTITY.registration}), and our directors, officers, employees, contractors, and agents (together, the "Indemnified Parties"), from and against any and all claims, demands, investigations, enforcement actions, fines, administrative penalties, licence fees, damages, losses, costs, and expenses (including reasonable legal fees on an attorney-and-client scale) arising out of or in connection with:`,
    ],
    bullets: [
      '(a) any fine, penalty, sanction, or cost levied or demanded by the Film and Publication Board or any other South African regulator because of content, products, media, or listings in your store, or because of your failure to classify or to hold a required registration;',
      '(b) any alleged distribution, hosting, or offering of unclassified, incorrectly classified, or prohibited films, games, publications, or adult content through your use of the Platform;',
      '(c) any take-down, preservation, or information request under the FP Act or the ECT Act that relates to your store; and',
      '(d) your breach of clause 8 or the Acceptable Use Policy.',
    ],
    after: [
      '11.2 This indemnity is in addition to any general indemnity in these Terms. It survives termination of your account and applies whether the claim is brought against us as alleged distributor, internet service provider, host, intermediary, or otherwise.',
      '11.3 We may defend any such matter with counsel of our choice. You will cooperate and, on demand, pay or reimburse all amounts described in this clause, including amounts we pay under protest or in settlement we reasonably accept.',
    ],
  },
  {
    heading: '12. Limitation of liability',
    paragraphs: [
      'To the maximum extent permitted by law, we are not liable for indirect, consequential, or lost-profit damages. Our aggregate liability to you in any 12-month period is limited to the fees you paid us in that period. This does not exclude liability that South African law does not allow us to exclude.',
      'Chapter XI of the ECT Act may limit our liability for third-party data we host if we meet its conditions, including membership of a recognised industry representative body and acting on a valid take-down notice. Those statutory limits are in addition to this clause.',
    ],
  },
  {
    heading: '13. Personal information',
    paragraphs: [
      `How we process personal information is described in our Privacy Policy at ${PATHS.privacy}. You are the responsible party for personal information of your own customers that you collect through your store.`,
    ],
  },
  {
    heading: '14. Changes, governing law, and contact',
    paragraphs: [
      'We may update these Terms by publishing a new version and changing the version number. For a material change we will prompt you to accept again. The current versions are always available on the Platform.',
      `These Terms are governed by the law of the Republic of South Africa. The courts of South Africa have exclusive jurisdiction.`,
      `Contact: ${LEGAL_ENTITY.email}. ${LEGAL_ENTITY.name}, Registration ${LEGAL_ENTITY.registration}.`,
    ],
  },
];

const AUP_SECTIONS = [
  {
    heading: '1. Purpose',
    paragraphs: [
      `This Acceptable Use Policy applies to every Merchant and team member on the Platform. It is version ${POLICY_VERSIONS.aup}, last updated ${POLICY_VERSIONS.publishedLabel}. It forms part of the Merchant Terms of Service.`,
    ],
  },
  {
    heading: '2. Classifiable media — strict prohibition',
    paragraphs: [
      'You may not sell, host, or distribute films, digital videos, adult content, or video games that have not been officially classified (or lawfully exempted) by the South African Film and Publication Board, unless Khana has given written permission under clause 8 of the Terms after you produce the required proof.',
      'You may not list XX material. You may not use the Platform as an adult shop or X18 outlet.',
    ],
  },
  {
    heading: '3. Other prohibited content',
    paragraphs: [
      'You may not use the Platform to upload, sell, or promote:',
    ],
    bullets: [
      'Child sexual abuse material or any sexual content involving a person under 18',
      'Content that advocates war, imminent violence, or hatred based on an identifiable group characteristic',
      'Stolen goods, counterfeit goods, or goods you do not have the right to sell',
      'Malware, phishing kits, or tools whose primary purpose is unauthorised access',
      'Unlawful drugs, illegal weapons, or other inventory that is illegal to sell in South Africa',
    ],
  },
  {
    heading: '4. Storefront conduct',
    paragraphs: [
      'You must not mislead customers, scrape other merchants\' catalogues, attack the Platform, or attempt to bypass usage, billing, or security controls. We may rate-limit, throttle, or disable features that threaten the service.',
    ],
  },
  {
    heading: '5. Enforcement',
    paragraphs: [
      'We may remove content or suspend your store immediately under clause 9 of the Terms, including after an FPB notice or an ECT Act take-down notification, without prior notice and without liability to you.',
    ],
  },
];

function takedownSections() {
  const agent = takeDownAgent();
  const addressLine = agent.address || 'Physical address: available on written request to the email below (set LEGAL_TAKEDOWN_ADDRESS when the registered office is confirmed).';
  const phoneLine = agent.phone || 'Telephone: available on written request to the email below (set LEGAL_TAKEDOWN_PHONE).';
  const ispaParagraph = agent.ispaMember
    ? `We are a member of the Internet Service Providers' Association (ISPA), a recognised Industry Representative Body under the ECT Act. Complainants may lodge a take-down through ISPA at ${PATHS.ispaTdn} or directly with the agent below.`
    : `We designate the agent below to receive take-down notifications under section 77 of the ECT Act. ISPA membership is not yet confirmed. Do not treat this page as a claim of Chapter XI safe-harbour membership. Complainants should write to the agent. After ISPA membership is confirmed (set LEGAL_ISPA_MEMBER=true), notices may also be lodged at ${PATHS.ispaTdn}.`;

  return [
    {
      heading: '1. Role',
      paragraphs: [
        `${LEGAL_ENTITY.name} hosts merchant storefronts. We do not actively monitor all merchant content. Version ${POLICY_VERSIONS.takedown}, last updated ${POLICY_VERSIONS.publishedLabel}.`,
        ispaParagraph,
      ],
    },
    {
      heading: '2. Designated take-down agent',
      paragraphs: [
        `Name: ${agent.name}`,
        `Entity: ${agent.entity}, Registration ${agent.registration}`,
        addressLine,
        phoneLine,
        `Email: ${agent.email}`,
        `ISPA process: ${PATHS.ispaTdn}`,
      ],
    },
    {
      heading: '3. What a notice must contain',
      paragraphs: [
        'A take-down notification must be in writing and must contain the particulars in section 77 of the ECT Act, including the complainant\'s name and address, the right alleged to be infringed, identification of the material, the remedial action sought, and a statement that the notice is given in good faith.',
      ],
    },
    {
      heading: '4. FPB notices',
      paragraphs: [
        'Notices about unclassified or prohibited films, games, or publications may also be sent by the FPB under section 18H of the FP Act. We will treat an FPB take-down or compliance notice as grounds for immediate suspension or removal under the Merchant Terms, without the merchant\'s prior consent.',
      ],
    },
    {
      heading: '5. How we act',
      paragraphs: [
        'We will act expeditiously to remove or disable access to the identified material. Sending a notice that is false or given in bad faith may attract liability under section 77(3) of the ECT Act. This page is a notice procedure, not a determination that the material is unlawful.',
        'If we hold an FPB registration certificate, the registration details will be added to this page and the site footer. No registration number is published until a certificate is issued.',
      ],
    },
  ];
}

function getDocument(id) {
  if (id === 'tos') {
    return {
      id: 'tos',
      title: 'Merchant Terms of Service',
      version: POLICY_VERSIONS.tos,
      path: PATHS.tos,
      sections: TOS_SECTIONS,
    };
  }
  if (id === 'aup') {
    return {
      id: 'aup',
      title: 'Acceptable Use Policy',
      version: POLICY_VERSIONS.aup,
      path: PATHS.aup,
      sections: AUP_SECTIONS,
    };
  }
  if (id === 'takedown') {
    return {
      id: 'takedown',
      title: 'Copyright and content take-down notices',
      version: POLICY_VERSIONS.takedown,
      path: PATHS.takedown,
      sections: takedownSections(),
    };
  }
  return null;
}

module.exports = {
  LEGAL_ENTITY,
  POLICY_VERSIONS,
  PATHS,
  takeDownAgent,
  legalPageUrl,
  publicLegalDocuments,
  currentPolicyVersions,
  publicLegalMeta,
  getDocument,
};

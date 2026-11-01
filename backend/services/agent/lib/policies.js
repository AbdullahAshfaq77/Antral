// Canonical, versioned policy documents for Antral's agentic security team.
//
// These are the single source of truth for what the user is shown and what we
// record them accepting. Bump a document's `version` whenever its `body`
// changes in a way that should require re-consent; the consent gate compares
// the accepted version against the current one here.
//
// NOTE: This is plain-language product policy, not legal advice. Have the text
// below reviewed by counsel before any public launch.

export const COMPANY_NAME = "Antral";

// ---------------------------------------------------------------------------
// Capability scopes
//
// Every per-target authorization grants an explicit subset of these. The gate
// checks that a given agent action's required scope was granted for the target
// it is about to touch. `risk` drives how prominently the UI warns the user.
// ---------------------------------------------------------------------------
export const SCOPES = [
  {
    id: "read_source",
    label: "Read source code & files",
    description:
      "Read the files of this target so the agents can review them for weaknesses.",
    risk: "standard",
    defaultOn: true,
  },
  {
    id: "static_analysis",
    label: "Run static analysis",
    description:
      "Analyse the source without executing it, to find insecure patterns and misconfigurations.",
    risk: "standard",
    defaultOn: true,
  },
  {
    id: "dependency_scan",
    label: "Scan dependencies",
    description:
      "Read dependency manifests and check them against public vulnerability databases.",
    risk: "standard",
    defaultOn: true,
  },
  {
    id: "github_read",
    label: "Read the GitHub repository",
    description:
      "Access the repository at the URL you provide, read-only, to review its code and history.",
    risk: "standard",
    defaultOn: true,
  },
  {
    id: "web_research",
    label: "Search the internet",
    description:
      "Look up advisories, CVEs and remediation guidance related to this target on the public web.",
    risk: "standard",
    defaultOn: true,
  },
  {
    id: "modify_files",
    label: "Create, edit & delete files",
    description:
      "Change files inside this target to apply fixes. You are asked to allow or decline each change, unless you choose to always allow it.",
    risk: "elevated",
    defaultOn: false,
  },
  {
    id: "execute_powershell",
    label: "Run PowerShell on your machine",
    description:
      "Execute PowerShell commands locally to perform checks and apply fixes. Read-only checks run directly; any other command asks you to allow or decline it first. Commands run with your account's privileges.",
    risk: "high",
    defaultOn: false,
  },
  {
    id: "android_device",
    label: "Access and control an Android phone",
    description:
      "Read the connected phone's device status and visible screen text, then launch installed apps or interact with the screen. Every phone action asks for your approval. This does not install apps or expose arbitrary ADB commands.",
    risk: "high",
    defaultOn: false,
  },
  {
    id: "launch_applications",
    label: "Find & open applications",
    description:
      "Discover installed applications on this PC and open them, or open files and projects in them. In a desktop folder target, this permission allows application discovery and launch outside the folder; other file access remains folder-scoped. Each launch asks for your approval.",
    risk: "elevated",
    defaultOn: false,
  },
  {
    id: "manage_processes",
    label: "View & close running programs",
    description:
      "List running programs on this PC and close a specific one, including from a desktop folder target. Closing always asks first, tries a graceful close, and force-ends only with a fresh approval.",
    risk: "high",
    defaultOn: false,
  },
  {
    id: "browser_automation",
    label: "Drive a web browser",
    description:
      "Open and control a browser to test the target the way a user would (for example, checking a running web app).",
    risk: "elevated",
    defaultOn: false,
  },
  {
    id: "background_execution",
    label: "Work in the background",
    description:
      "Continue running tasks on your machine in the background after you close the active view.",
    risk: "elevated",
    defaultOn: false,
  },
];

export const SCOPE_IDS = SCOPES.map((s) => s.id);
export const isValidScope = (id) => SCOPE_IDS.includes(id);

// The Global target (This PC) has every capability; kill-switches and
// per-action approvals still apply.
export const effectiveScopes = (authorization) =>
  authorization.target?.type === "computer" ? SCOPE_IDS : authorization.scopes;

// Bases a user can rely on to assert they are allowed to assess a target.
export const AUTHORIZATION_BASES = [
  { id: "owner", label: "I own this target" },
  {
    id: "written_permission",
    label: "I have written permission from the owner to test it",
  },
  {
    id: "employer_authorized",
    label: "I am authorized by my employer/organization to test it",
  },
];
export const AUTHORIZATION_BASIS_IDS = AUTHORIZATION_BASES.map((b) => b.id);

// Target types the agents can be pointed at.
export const TARGET_TYPES = ["local", "computer", "github", "host", "project"];
export const LOCAL_COMPUTER_TARGET_ENABLED = process.env.ANTRAL_LOCAL_DESKTOP === "1";

// How long a per-target authorization stays valid before it must be renewed.
export const TARGET_AUTH_TTL_DAYS = 90;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
const EFFECTIVE_DATE = "2026-10-05";

// Documents the user must accept once, at the account level, before using the
// product at all.
export const ACCOUNT_DOCUMENTS = [
  {
    id: "terms",
    title: "Terms of Service",
    version: "1.0.0",
    effectiveDate: EFFECTIVE_DATE,
    summary:
      "The rules for using Antral, including that you use it only on systems you are allowed to test.",
    body: `# ${COMPANY_NAME} Terms of Service

_Effective ${EFFECTIVE_DATE} · Version 1.0.0_

## 1. What ${COMPANY_NAME} is
${COMPANY_NAME} is a team of automated security agents that reviews software you
point it at, identifies weaknesses, and suggests fixes. To do this it can read
your code, read GitHub repositories you provide, search the public internet,
and — only where you explicitly allow it — run commands on your computer.

## 2. You must be authorized to test the target
You may only use ${COMPANY_NAME} against systems, code, repositories and
machines that **you own or are explicitly authorized to assess**. Before the
agents touch any target you will be asked to confirm this for that specific
target. Testing systems without authorization may be illegal. You are solely
responsible for making sure you have permission.

## 3. Your responsibilities
You agree not to use ${COMPANY_NAME} to attack, disrupt, or gain unauthorized
access to any system; to exfiltrate data you have no right to; or to do anything
unlawful. You are responsible for everything done under your account and for
reviewing the agents' actions and output before you act on them.

## 4. The agents act on your instructions
${COMPANY_NAME} runs automated actions on your behalf and with your granted
permissions. It can make mistakes, miss issues, or report false positives. Its
output is guidance, not a guarantee of security. You decide what to run and what
changes to make.

## 5. No warranty; limitation of liability
${COMPANY_NAME} is provided "as is", without warranties of any kind. To the
fullest extent permitted by law, we are not liable for any damage to your
systems or data, missed vulnerabilities, or losses arising from your use of the
product.

## 6. Changes
We may update these terms. If we make a material change we will ask you to
review and accept the new version before you continue.

## 7. Termination
You may stop using ${COMPANY_NAME} at any time and withdraw your consent. We may
suspend access that we believe is being used in violation of these terms.`,
  },
  {
    id: "privacy",
    title: "Privacy Policy",
    version: "1.2.0",
    effectiveDate: "2026-10-06",
    summary:
      "What data Antral reads and stores, including your code, scan results, connected-device content, and consent records.",
    body: `# ${COMPANY_NAME} Privacy Policy

_Effective 2026-10-06 · Version 1.1.0_

## 1. What we process
To do its job, ${COMPANY_NAME} processes:
- **Account data** — your email and sign-in identity.
- **Target data** — the source code, files, repository contents and host
  details of the targets you authorize us to assess.
- **Connected-device content** — if you enable Android access, the visible
  screen's text and accessibility labels, plus the actions you ask the agent to
  perform. This content can be included in the run history and sent to the
  configured AI model provider.
- **Scan results** — the findings, reports and logs the agents produce.
- **Consent records** — a record of the policies you accepted and the targets
  you authorized, including the time, your IP address and browser, kept as proof
  of authorization.

## 2. Local and system access
Where you grant it, ${COMPANY_NAME} runs on your own computer and may read files
and run commands locally. If you separately enable Android access, it can read
the connected phone's device status and visible screen labels, and operate
installed apps through approved screen interactions. It does not install apps
or provide arbitrary ADB shell access through the Android tools. This content
is processed to carry out your task.

## 3. Third parties
When you ask the agents to research an issue they may query public sources on
the internet (for example, vulnerability databases). We do not sell your data.

## 4. Retention
We keep scan results and consent records for as long as your account is active
or as needed to show that a target was authorized. You can request deletion of
your data.

## 5. Security of your data
Your code and findings can be sensitive. We protect them with access controls
and encryption in transit. No system is perfectly secure.

## 6. Your choices
You can view what you have authorized, revoke any target authorization, and
withdraw account-level consent, which stops further processing.`,
  },
  {
    id: "acceptableUse",
    title: "Acceptable Use Policy",
    version: "1.0.0",
    effectiveDate: EFFECTIVE_DATE,
    summary:
      "What you may and may not do with Antral's agents and their system access.",
    body: `# ${COMPANY_NAME} Acceptable Use Policy

_Effective ${EFFECTIVE_DATE} · Version 1.0.0_

${COMPANY_NAME} gives automated agents real access to code, the internet and —
when you allow it — your computer. Use it responsibly.

## You MAY
- Assess software, repositories and machines you own.
- Assess targets you have explicit, documented authorization to test.
- Use the findings to fix and harden your own systems.

## You MAY NOT
- Point the agents at any system you are not authorized to test.
- Use ${COMPANY_NAME} to launch denial-of-service attacks, spread malware, or
  gain or maintain unauthorized access to any system.
- Use it to attack third parties, mass-target hosts, or evade another party's
  security controls for malicious purposes.
- Use granted local/PowerShell access to damage systems or data, or to act
  beyond the target you authorized.

## Dangerous capabilities
Some capabilities — running PowerShell on your machine, driving a browser,
controlling a connected Android phone, and background execution — carry real
risk. They are off by default and must be granted per target. Only enable them
when you understand what the agents will do and accept that risk.

## Enforcement
Authorizations are scoped to specific targets and expire. We may refuse or halt
actions that fall outside what you authorized or that appear to violate this
policy.`,
  },
];

// The per-target authorization document. Shown each time a user authorizes a
// new target, alongside the scope choices.
export const TARGET_AUTHORIZATION_DOCUMENT = {
  id: "targetAuthorization",
  title: "Target Authorization",
  version: "1.1.0",
  effectiveDate: EFFECTIVE_DATE,
  summary:
    "Your attestation that you are allowed to test this specific target, including every accessible local drive when you choose This PC.",
  body: `# Authorize a target

You are about to let ${COMPANY_NAME}'s agents act on a specific target. Before
they do, confirm the following:

1. **Authorization.** You own this target, or you have explicit permission to
   assess it. Testing a system you are not authorized to test may be illegal,
   and you take sole responsibility for having that authorization.

2. **Scope.** For a folder or repository, agents act only on that target. If you
   choose **This PC**, read access covers every local drive accessible to the
   desktop agent, and file changes or PowerShell commands require your approval
   each time. Files you ask the agent to read may be sent to your configured AI
   provider.

3. **Risk.** Some permissions let the agents run commands on your computer,
   drive a browser, or read and interact with a connected Android phone. Phone
   actions require your approval. You understand what each granted permission
   allows and accept the risk.

4. **Record.** We record this authorization — the target, the permissions, the
   time, your IP address and browser — as proof that you authorized this work.

This authorization expires after
${TARGET_AUTH_TTL_DAYS} days, and can be revoked by you at any time.`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export const CURRENT_ACCOUNT_VERSIONS = Object.fromEntries(
  ACCOUNT_DOCUMENTS.map((d) => [d.id, d.version]),
);

export const CURRENT_TARGET_AUTH_VERSION = TARGET_AUTHORIZATION_DOCUMENT.version;

// Public shape for the frontend: metadata + full body, no internal fields.
export const publicAccountDocuments = () =>
  ACCOUNT_DOCUMENTS.map(({ id, title, version, effectiveDate, summary, body }) => ({
    id,
    title,
    version,
    effectiveDate,
    summary,
    body,
  }));

export const publicTargetAuthorization = () => ({ ...TARGET_AUTHORIZATION_DOCUMENT });

export const publicScopes = () => SCOPES.map((s) => ({ ...s }));

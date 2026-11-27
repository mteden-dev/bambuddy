/**
 * Fork: the server's English texts in the user's language.
 *
 * The API keeps its English error details and waiting reasons: tests,
 * PRODUCTS_API.md and API users read them. This turns the ones the fork sends
 * into keys under `serverMessages` (i18n/serverMessages). Anything it does not
 * know is shown as it came, so upstream messages stay as they are.
 */
import i18next from 'i18next';
import table from '../api/serverMessages.json';

export type Translate = (key: string, options?: Record<string, unknown>) => string;

interface ErrorEntry {
  text?: string;
  pattern?: string;
  key: string;
  lookup?: string;
}

const ERRORS = table.errors as ErrorEntry[];
const EXACT = new Map(ERRORS.filter((e) => e.text !== undefined).map((e) => [e.text as string, e]));
const PATTERNS = ERRORS.filter((e) => e.pattern !== undefined).map((e) => ({ re: new RegExp(e.pattern as string), entry: e }));

/** Every key the table points at under serverMessages.errors (for tests). */
export const SERVER_ERROR_KEYS = ERRORS.map((e) => e.key);

function appTranslate(): Translate | null {
  // Before i18n is up (or in a test without it) the English text is the answer.
  return i18next.isInitialized ? (i18next.t.bind(i18next) as unknown as Translate) : null;
}

/** A plan's refusal code ("offline", "model") in the words the timeline uses for it. */
function refusalReason(prefix: string, code: string, detail: string | undefined, t: Translate): string {
  if (code === 'model' && !detail) return t(`${prefix}.modelUnknown`);
  const text = t(`${prefix}.${code}`, { model: detail, location: detail, defaultValue: '' });
  if (text && text !== `${prefix}.${code}`) return text;
  return detail ? `${t(`${prefix}.other`)} (${detail})` : t(`${prefix}.other`);
}

/** One English error detail from the server in the user's language, or as it came when unknown. */
export function translateServerError(message: string, t: Translate | null = appTranslate()): string {
  if (!t) return message;
  const exact = EXACT.get(message);
  if (exact) return t(`serverMessages.errors.${exact.key}`);
  for (const { re, entry } of PATTERNS) {
    const match = re.exec(message);
    if (!match) continue;
    const params: Record<string, unknown> = { ...match.groups };
    if (entry.lookup && match.groups?.code) {
      params.reason = refusalReason(entry.lookup, match.groups.code, match.groups.detail, t);
    }
    return t(`serverMessages.errors.${entry.key}`, params);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Waiting reasons. The scheduler writes one line per held job
// (print_scheduler.py): parts joined with " | ", and for a job with
// alternatives for several models, "MODEL: reason" per model joined with "; ".

const W = 'serverMessages.waiting';

type Fix = (value: string, t: Translate) => string;
const nozzleSides: Fix = (v, t) =>
  v.replace(/\(left nozzle\)/g, t(`${W}.leftNozzle`)).replace(/\(right nozzle\)/g, t(`${W}.rightNozzle`));
const drying: Fix = (v, t) => v.replace(/\(drying\)/g, t(`${W}.drying`));
const needs: Fix = (v, t) => nozzleSides(v.replace(/\(needs /g, `(${t(`${W}.needsWord`)} `), t);
const nozzles: Fix = (v, t) =>
  v.replace(/no nozzle mounted/g, t(`${W}.noNozzleMounted`)).replace(/, rack /g, `, ${t(`${W}.rack`)} `);

interface Shape {
  re: RegExp;
  key: string;
  // Words of the scheduler inside a parameter ("P1S-2 (drying)").
  fix?: Record<string, Fix>;
}

// Order matters where one shape starts like another (the Offline ones).
const SHAPES: Shape[] = [
  { re: /^Offline: (?<printer>.+) — the smart plug could not power it on$/, key: 'offlinePlugFailed' },
  { re: /^Offline, no Auto On smart plug: (?<printers>.+)$/, key: 'offlineNoPlug' },
  { re: /^Offline: (?<printers>.+)$/, key: 'offline' },
  { re: /^Busy: (?<printers>.+)$/, key: 'busy', fix: { printers: drying } },
  { re: /^Waiting for plate confirmation: (?<printer>.+)$/, key: 'plateConfirmation' },
  { re: /^Waiting for filament: (?<printers>.+)$/, key: 'filament', fix: { printers: needs } },
  { re: /^No matching material\/color\. Waiting on (?<filaments>.+)$/, key: 'noMatchingFilament', fix: { filaments: nozzleSides } },
  { re: /^Needs (?<filaments>.+)$/, key: 'needs', fix: { filaments: nozzleSides } },
  { re: /^Waiting on (?<sensor>.+)$/, key: 'sensor' },
  { re: /^Its owner no longer has access to this printer — move it to another printer$/, key: 'ownerLostAccess' },
  { re: /^Every file for this job has been deleted — add a file back or remove the item$/, key: 'filesDeleted' },
  {
    re: /^File was sliced for (?<sliced>.+), which is not compatible with (?<target>.+) — edit the item and fix its target model$/,
    key: 'slicedForOtherModel',
  },
  { re: /^The last print failed on every free matching printer$/, key: 'lastPrintFailed' },
  { re: /^No active (?<model>.+?) printers in (?<location>.+) configured$/, key: 'noActivePrintersIn' },
  { re: /^No active (?<model>.+?) printers configured$/, key: 'noActivePrinters' },
  { re: /^No available (?<model>.+?) printers in (?<location>.+)$/, key: 'noAvailablePrintersIn' },
  { re: /^No available (?<model>.+?) printers$/, key: 'noAvailablePrinters' },
  { re: /^No (?<model>.+?) in (?<location>.+) has a (?<nozzle>[\d.]+)mm nozzle: (?<printers>.+)$/, key: 'noNozzleIn', fix: { printers: nozzles } },
  { re: /^No (?<model>.+?) has a (?<nozzle>[\d.]+)mm nozzle: (?<printers>.+)$/, key: 'noNozzle', fix: { printers: nozzles } },
  {
    re: /^(?<printer>.+) refused to store the file — check its SD card or USB drive\. Bambuddy will retry automatically$/,
    key: 'refusedStorage',
  },
  {
    re: /^(?<printer>.+) refused the file transfer — check its access code on the Printers page\. Bambuddy will retry automatically$/,
    key: 'refusedAuth',
  },
  {
    re: /^(?<printer>.+) has no file-transfer sessions left \(421 too many connections\) — if this does not clear within a few minutes, restart the printer\. Bambuddy will retry automatically$/,
    key: 'refusedSessions',
  },
  { re: /^(?<printer>.+) is not accepting files — Bambuddy will retry automatically$/, key: 'refusedOther' },
  {
    re: /^No filament loaded on this printer matches the file\. It needs (?<want>.+); the printer has (?<have>.+) and no AMS\. Load the required filament on the external spool holder, or send this job to a printer that has it\.$/,
    key: 'noFilamentNoAms',
    fix: { want: nozzleSides, have: nozzleSides },
  },
];

function matchShape(text: string): { shape: Shape; groups: Record<string, string> } | null {
  for (const shape of SHAPES) {
    const match = shape.re.exec(text);
    if (match) return { shape, groups: { ...match.groups } };
  }
  return null;
}

function translateClause(clause: string, t: Translate): string {
  const found = matchShape(clause);
  if (!found) return clause;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(found.groups)) {
    const fix = found.shape.fix?.[name];
    params[name] = fix ? fix(value, t) : value;
  }
  return t(`${W}.${found.shape.key}`, params);
}

const translateClauses = (text: string, t: Translate) =>
  text.split(' | ').map((clause) => translateClause(clause.trim(), t)).join(' | ');

function translateModelPart(part: string, t: Translate): string {
  if (matchShape(part.split(' | ')[0].trim())) return translateClauses(part, t);
  // "P1S: Busy: P1S-2", where the model is not itself a reason.
  const prefixed = /^(?<model>[^:|]{1,40}): (?<rest>.+)$/s.exec(part);
  if (prefixed?.groups && matchShape(prefixed.groups.rest.split(' | ')[0].trim())) {
    const model = prefixed.groups.model === 'unassigned' ? t(`${W}.unassigned`) : prefixed.groups.model;
    return `${model}: ${translateClauses(prefixed.groups.rest, t)}`;
  }
  return translateClauses(part, t);
}

// A "; " that starts another model's reason ("; X1C: Busy: ..."), not one
// inside a filament list ("A (needs PLA); B (needs PETG)").
const MODEL_SEPARATOR = /; (?=[^;:|()]{1,40}: )/;

/** A queue job's waiting_reason in the user's language; parts it does not know stay as they are. */
export function translateWaitingReason(reason: string, t: Translate): string;
export function translateWaitingReason(reason: string | null | undefined, t: Translate): string | null | undefined;
export function translateWaitingReason(reason: string | null | undefined, t: Translate): string | null | undefined {
  if (!reason) return reason;
  return reason
    .split(MODEL_SEPARATOR)
    .map((part) => translateModelPart(part, t))
    .join('; ');
}

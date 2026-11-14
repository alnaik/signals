// What runs inside an application page: reading its fields and choosing options. No imports, so
// the Chrome extension bundles it as is, and readFormFields can be handed to page.evaluate.

export type Question = {
  label: string;
  name: string;
  type: string;
  required: boolean;
  options?: string[];
  value?: string; // what the field holds now, read from the page
  autocomplete?: string;
  unlabeled?: boolean; // no label of its own: only its placeholder or name names it
  touched?: boolean; // the extension: you typed or picked it yourself (only then is it learned)
};

/**
 * Runs in the page (passed to page.evaluate): every form field with its label, name, type, required.
 * A radio group or a Yes/No button pair is one question: its label is the group's title, not an
 * option's, and the options ride along. A Workday dropdown (a button over a list) is a type-and-pick
 * question, its options read only when it's opened to fill it. Must stay self-contained (no outer helpers). The extension
 * asks for each field's element too, to fill it; page.evaluate can't carry elements, so by default not.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: page.evaluate passes void when given no argument
export function readFormFields(withElements: boolean | void = false): (Question & { el?: Element })[] {
  const out: (Question & { el?: Element })[] = [];
  const seen = new Set<string>();
  const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  // The question an input belongs to: a fieldset's legend, or the title of the entry it sits in.
  const groupTitle = (el: Element): string => {
    const box = el.closest(
      'fieldset, [role="radiogroup"], [role="group"], .ashby-application-form-field-entry',
    );
    if (!box) return "";
    const title = box.querySelector("legend, .ashby-application-form-question-title");
    if (title) return text(title);
    const first = box.firstElementChild;
    return first && !first.querySelector("input, textarea, select") ? text(first) : "";
  };
  // The question a file input answers: its own label is often its button's word ("Attach" on
  // Greenhouse, for the CV and the cover letter alike); the upload's group names it.
  const uploadTitle = (el: Element): string => {
    const ids = el.closest('[role="group"][aria-labelledby]')?.getAttribute("aria-labelledby") ?? "";
    return ids
      .split(/\s+/)
      .map((i) => (i ? text(document.getElementById(i)) : ""))
      .join(" ")
      .trim();
  };
  // The heading of the section an input sits in (the nearest one around it): Workday's resume
  // upload has no label, only its section's "Resume/CV".
  const sectionOf = (el: Element): Element | null => {
    for (let box = el.parentElement; box && box !== document.body; box = box.parentElement)
      if (box.querySelector("h1, h2, h3, h4, h5, h6")) return box;
    return null;
  };
  const sectionTitle = (el: Element): string => text(sectionOf(el)?.querySelector("h1, h2, h3, h4, h5, h6"));
  // The file an upload holds: its own, or one its section shows (Workday shows the CV it took from
  // "Autofill with Resume" by name in the Resume/CV section, beside an empty input).
  const FILE_NAME = /[^\s/\\]+\.(pdf|docx?|rtf|txt|odt)\b/i;
  const heldFile = (input: HTMLInputElement, bySection: boolean): string => {
    const own = input.files?.[0]?.name;
    if (own || !bySection) return own ?? "";
    const box = sectionOf(input);
    const shown = box?.querySelector(
      '[data-automation-id="file-upload-successful"], [data-automation-id="file-upload-item"]',
    );
    return (text(shown) || text(box)).match(FILE_NAME)?.[0] ?? (shown ? text(shown) : "");
  };
  // Workday's dropdown: a button that opens a list elsewhere on the page (aria-controls); its text
  // is the pick, "Select One" when none. Its aria-label says the pick, not the question.
  const LISTBOX = 'button[aria-haspopup="listbox"]';
  // The page's own menus (language, settings, account) sit in its header, outside the form.
  const MENU = /^(languageSelectorButton|settingsSelectorButton|accountSettingsButton)$/;
  // An entry of work history or education Workday draws on Add (workExperience-6--jobTitle,
  // education-23--school): left to you until work history is built, so never read.
  const ENTRY = /^(workExperience|education)-\d+(--|$)/;
  const inEntry = (el: Element) => {
    for (let e: Element | null = el; e; e = e.parentElement) if (ENTRY.test(e.id)) return true;
    return false;
  };
  // The item a search box shows as picked, in its own field (Workday's formField box, or the
  // multi-select box around it): Workday's selected item. Never wider (a page's whole form), and not
  // any option marked selected: a phone's country list (intl-tel-input) marks its country so.
  const SELECTED =
    '[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] [role="option"]';
  const selectedItem = (input: HTMLInputElement): Element | null =>
    input
      .closest('[data-automation-id^="formField"], [data-automation-id="multiSelectContainer"]')
      ?.querySelector(SELECTED) ?? null;
  for (const el of Array.from(document.querySelectorAll(`input, textarea, select, ${LISTBOX}`))) {
    const input = el as HTMLInputElement;
    if (inEntry(el)) continue;
    if (el.tagName === "BUTTON") {
      if (MENU.test(el.getAttribute("data-automation-id") ?? "") || el.closest("header, nav, [role=banner]"))
        continue;
      if (el.closest('[aria-hidden="true"], .iti')) continue;
      // Named by its label, or by its fieldset's legend (Workday's questions); else not a question.
      const named =
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
        el.closest("fieldset")?.querySelector("legend")?.textContent ||
        "";
      const clean = named
        .replace(/\s+/g, " ")
        .replace(/[✱*]\s*$/, "")
        .trim();
      const name = el.getAttribute("name") || el.id;
      if (!clean || seen.has(`${clean}|${name}`)) continue;
      seen.add(`${clean}|${name}`);
      const value = /^select one$/i.test(text(el)) ? "" : text(el);
      out.push({
        label: clean,
        name,
        type: "combobox",
        required:
          /\brequired$/i.test(el.getAttribute("aria-label") ?? "") ||
          el.getAttribute("aria-required") === "true" ||
          /\*|✱/.test(named),
        ...(value ? { value } : {}),
        ...(withElements ? { el } : {}),
      });
      continue;
    }
    if (["hidden", "submit", "button"].includes(input.type)) continue;
    if (/^(g-recaptcha|h-captcha)/.test(input.name)) continue;
    // A widget's own parts, not questions: react-select's hidden required input (aria-hidden), and
    // the phone field's country search (intl-tel-input), which fills nothing but its list of flags.
    if (input.getAttribute("aria-hidden") === "true") continue;
    if (input.closest(".iti__country-container, .iti__dropdown-content, .iti--container")) continue;
    const id = input.id;
    const own = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : "";
    // The text input Workday keeps beside each dropdown, unlabeled: part of it, not a question.
    if (!own && !input.getAttribute("aria-label") && input.parentElement?.querySelector(LISTBOX)) continue;
    const choice = input.type === "radio" || input.type === "checkbox";
    // A lone checkbox under Yes/No buttons (Ashby's boolean question) is answered by the buttons.
    const box = input.closest(".ashby-application-form-field-entry, fieldset");
    const buttons = box
      ? Array.from(box.querySelectorAll("button"))
          .map((b) => text(b))
          .filter((t) => /^(yes|no)$/i.test(t))
      : [];
    const group = choice && (input.type === "radio" || buttons.length === 2) ? groupTitle(input) : "";
    // What names it on the page; failing that, only its placeholder or name (no label of its own:
    // maybe a trap for bots, so the extension types nothing from the profile in it).
    const named =
      group ||
      (input.type === "file" ? uploadTitle(input) : "") ||
      own ||
      input.getAttribute("aria-label") ||
      input.closest("label")?.textContent ||
      input.closest("fieldset")?.querySelector("legend")?.textContent ||
      groupTitle(input) ||
      (input.type === "file" ? sectionTitle(input) : "") ||
      input.closest("div")?.querySelector("label, .application-label, .text")?.textContent;
    const label = named || input.placeholder || input.name;
    const clean = (label ?? "")
      .replace(/\s+/g, " ")
      .replace(/[✱*]\s*$/, "")
      .trim();
    // One question per label and name: a radio group's inputs share theirs. Two fields with no name
    // stay two (Greenhouse's Phone has only an id).
    const key = `${clean}|${input.name || id}`;
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    let options: string[] | undefined;
    // What it holds now: the checked option's label, the chosen option, or the text typed.
    // A password's value is never read.
    let value = "";
    if (group && input.type === "radio") {
      const same = Array.from(
        document.querySelectorAll(`input[type="radio"][name="${CSS.escape(input.name)}"]`),
      ) as HTMLInputElement[];
      const labelOf = (r: HTMLInputElement) =>
        text((r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest("label"));
      options = same.map(labelOf).filter(Boolean);
      const checked = same.find((r) => r.checked);
      value = checked ? labelOf(checked) : "";
    } else if (group) options = buttons;
    else if (el.tagName === "SELECT") {
      const o = (el as unknown as HTMLSelectElement).selectedOptions[0];
      value = o?.value ? text(o) : "";
    } else if (input.type === "file") value = heldFile(input, !!named && named === sectionTitle(input));
    else if (!choice && input.type !== "password") value = input.value.trim();
    // A type-and-pick box (react-select on Greenhouse, Ashby's location): the pick shows beside
    // the input, which is empty again once an option is chosen.
    const combo = input.getAttribute("role") === "combobox";
    if (combo && !value)
      value = text(
        input
          .closest('[class*="control"], [class*="Control"]')
          ?.querySelector('[class*="single-value"], [class*="singleValue"]'),
      );
    // A search box whose pick shows beside it as a selected item (Workday's Country Phone Code:
    // "United States of America (+1)" over an empty search) holds that pick.
    if (!value && !choice && input.type !== "file") value = text(selectedItem(input));
    const autocomplete = input.getAttribute("autocomplete");
    out.push({
      label: clean,
      name: input.name || id,
      type: group
        ? "radio"
        : combo
          ? "combobox"
          : el.tagName === "TEXTAREA"
            ? "textarea"
            : input.type || el.tagName.toLowerCase(),
      required:
        input.required ||
        input.getAttribute("aria-required") === "true" ||
        /\*|✱/.test(label ?? "") ||
        !!box?.querySelector('[class*="required"]'),
      ...(options?.length ? { options } : {}),
      ...(value ? { value } : {}),
      ...(autocomplete ? { autocomplete } : {}),
      ...(named?.trim() ? {} : { unlabeled: true }),
      ...(withElements ? { el } : {}),
    });
  }
  return out;
}

/** The option a value picks: exact first, then one starting with it ("Yes" → "Yes, I'm…"). */
export function pickOption(options: string[], value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  return (
    options.find((o) => o.toLowerCase() === v) ?? options.find((o) => o.toLowerCase().startsWith(v)) ?? null
  );
}

/** The option a dropdown should take: exact, then starting with the value, then naming its first part ("Boulder"). */
export function comboOption(options: string[], value: string): string | null {
  const first = value.split(",")[0]!.trim().toLowerCase();
  return (
    pickOption(options, value) ??
    (first ? (options.find((o) => o.toLowerCase().includes(first)) ?? null) : null)
  );
}

/**
 * The option a degree dropdown should take for a CV's degree ("B.S." → "Bachelor's Degree"): the
 * same words first, else one at the same level (associate, bachelor, master, doctor), one of the
 * same kind (Science, Arts) before a plain one ("Bachelor's"), and that before another kind.
 */
export function degreeOption(options: string[], degree: string): string | null {
  const exact = pickOption(options, degree);
  if (exact) return exact;
  const words = (s: string) => s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  const level = (s: string): string => {
    const t = words(s);
    if (/\b(phd|doctor|doctorate|dphil|edd)/.test(t)) return "doctor";
    if (/\bmaster|\b(ms|ma|msc|mba|meng|mfa|mph)\b/.test(t)) return "master";
    if (/\b(bachelor|baccalaureate)|\b(bs|ba|bsc|beng|bfa|bba|btech)\b/.test(t)) return "bachelor";
    if (/\bassociate|\b(aa|as|aas)\b/.test(t)) return "associate";
    return "";
  };
  const KINDS: Record<string, string> = {
    s: "science",
    sc: "science",
    a: "arts",
    eng: "engineering",
    fa: "fine arts",
    ba: "business administration",
  };
  const kind = (s: string): string => {
    const t = words(s);
    const long = t.match(/\bof ([a-z ]+?)(?: in\b|$)/);
    if (long) return long[1]!;
    const short = t.match(/\b[bm](sc|s|a|eng|fa|ba)\b/);
    return short ? KINDS[short[1]!]! : "";
  };
  const want = level(degree);
  if (!want) return null;
  const same = options.filter((o) => level(o) === want);
  return (
    same.find((o) => kind(o) && kind(o) === kind(degree)) ?? same.find((o) => !kind(o)) ?? same[0] ?? null
  );
}

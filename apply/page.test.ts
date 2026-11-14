// The page-side readers, in a browser page: what a form's questions look like to the board.
import { expect, test } from "bun:test";
import { pickOption, readFormFields } from "./page.ts";

// Greenhouse's phone field, trimmed: a react-select Country (with its hidden required input) and
// intl-tel-input's number, whose country search is a combobox of its own.
const PHONE = `<form><fieldset class="phone-input"><legend class="visually-hidden">Phone</legend>
  <div class="phone-input__country"><label id="country-label" for="country">Country*</label>
    <div class="select__control"><input id="country" role="combobox" aria-required="true" value="">
      <input required tabindex="-1" aria-hidden="true" class="css-requiredInput" value=""></div></div>
  <div class="phone-input__phone"><label id="phone-label" for="phone">Phone*</label>
    <div class="iti"><div class="iti__country-container">
      <button type="button" class="iti__selected-country" aria-label="Select country"></button>
      <div id="iti-0__dropdown-content" class="iti__dropdown-content" role="dialog">
        <input id="iti-0__search-input" type="search" class="iti__search-input" placeholder="Search"
          role="combobox" aria-label="Search" aria-controls="iti-0__country-listbox">
        <ul id="iti-0__country-listbox" role="listbox"><li role="option">United States</li></ul></div></div>
      <input id="phone" class="iti__tel-input" aria-label="Phone" aria-required="true" type="tel"
        autocomplete="off" value=""></div></div>
</fieldset></form>`;

test("a radio group or Yes/No buttons is one question with options", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Ashby's markup, trimmed: a radio fieldset, and a boolean as Yes/No buttons over a hidden checkbox.
    const html = `<form>
      <fieldset class="ashby-application-form-field-entry">
        <label class="ashby-application-form-question-title">Would you be willing to relocate?</label>
        <div><input type="radio" id="r1" name="rel"><label for="r1">Yes, I'm already planning to relocate</label></div>
        <div><input type="radio" id="r2" name="rel"><label for="r2">Yes</label></div>
        <div><input type="radio" id="r3" name="rel"><label for="r3">Unsure</label></div>
      </fieldset>
      <div class="ashby-application-form-field-entry">
        <label class="ashby-application-form-question-title _required_x" for="s">Will you need visa sponsorship?</label>
        <button type="button" onclick="document.getElementById('s').checked=true">Yes</button>
        <button type="button" onclick="document.getElementById('s').checked=false">No</button>
        <input type="checkbox" id="s" name="s" style="display:none">
      </div>
      <textarea name="g-recaptcha-response"></textarea>
    </form>`;
    await page.route("**/*", (r) => r.fulfill({ body: html, contentType: "text/html" }));
    await page.goto("https://jobs.ashbyhq.com/acme/1/application");
    const qs = await page.evaluate(readFormFields);
    expect(qs).toEqual([
      {
        label: "Would you be willing to relocate?",
        name: "rel",
        type: "radio",
        required: false,
        options: ["Yes, I'm already planning to relocate", "Yes", "Unsure"],
      },
      {
        label: "Will you need visa sponsorship?",
        name: "s",
        type: "radio",
        required: true,
        options: ["Yes", "No"],
      },
    ]);
  } finally {
    await browser.close();
  }
}, 30_000);

test("a file input is named by its upload's group, not by its Attach button", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Greenhouse's markup, trimmed: both uploads' own labels say Attach.
    const upload = (id: string, title: string, required: boolean) => `
      <div role="group" aria-labelledby="upload-label-${id}" aria-required="${required}" class="file-upload">
        <div class="label upload-label" id="upload-label-${id}">${title}</div>
        <div class="file-upload__wrapper"><div class="button-container"><div class="secondary-button"><div>
          <button type="button">Attach</button><label class="visually-hidden" for="${id}">Attach</label>
          <input id="${id}" class="visually-hidden" type="file" accept=".pdf">
        </div></div></div></div>
      </div>`;
    await page.setContent(
      `<form>${upload("resume", "Resume/CV<span aria-hidden='true'>*</span>", true)}${upload("cover_letter", "Cover Letter", false)}</form>`,
    );
    expect(await page.evaluate(readFormFields)).toEqual([
      { label: "Resume/CV", name: "resume", type: "file", required: true },
      { label: "Cover Letter", name: "cover_letter", type: "file", required: false },
    ]);
  } finally {
    await browser.close();
  }
}, 30_000);

test("Greenhouse's phone is one question: its country search and react-select's hidden input aren't read", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(PHONE);
    expect(await page.evaluate(readFormFields)).toEqual([
      { label: "Country", name: "country", type: "combobox", required: true },
      { label: "Phone", name: "phone", type: "tel", required: true, autocomplete: "off" },
    ]);
  } finally {
    await browser.close();
  }
}, 30_000);

test("Workday's resume upload, with no label, is named by its section's heading", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-automation-id="applyFlowPage"><h2>My Experience</h2>
      <div data-automation-id="resumeSection"><h3>Resume/CV</h3>
        <div data-automation-id="file-upload-drop-zone"><p>Drop file here</p>
          <button type="button" data-automation-id="select-files">Select files</button>
          <input type="file" data-automation-id="file-upload-input-ref" style="display:none"></div></div></div>`);
    expect(await page.evaluate(readFormFields)).toEqual([
      { label: "Resume/CV", name: "", type: "file", required: false },
    ]);
  } finally {
    await browser.close();
  }
}, 30_000);

test("pickOption: exact first, then an option starting with the value", () => {
  expect(pickOption(["Yes, I'm already planning to relocate", "Yes", "No"], "yes")).toBe("Yes");
  expect(pickOption(["Yes, definitely", "No"], "Yes")).toBe("Yes, definitely");
  expect(pickOption(["Yes", "No"], "Maybe")).toBeNull();
});

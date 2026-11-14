/// <reference types="chrome" />
// The notice the form script shows on another company's form in a tab Apply opened: the
// extension's own page, in a frame the page can't read or click into. Its words come from the
// worker as plain text. Fill counts only while the button has been in plain view for a moment
// (nothing of the page's laid over it, faded or moved), so a page can't trick a click onto it.
const nonce = location.hash.slice(1);
const say = document.getElementById("say")!;
const fill = document.getElementById("fill") as HTMLButtonElement;
const leave = document.getElementById("leave") as HTMLButtonElement;

chrome.runtime.sendMessage({ type: "notice", nonce }).then((r: { text?: string } | undefined) => {
  say.textContent = r?.text ?? "";
});

let since = 0; // when Fill came into plain view; 0 while it isn't
new IntersectionObserver(
  (seen) => {
    for (const e of seen)
      since = (e as IntersectionObserverEntry & { isVisible?: boolean }).isVisible ? Date.now() : 0;
  },
  { threshold: 1, trackVisibility: true, delay: 100 } as IntersectionObserverInit,
).observe(fill);

const answer = (yes: boolean) => chrome.runtime.sendMessage({ type: "answer", nonce, fill: yes });
fill.addEventListener("click", (e) => {
  if (e.isTrusted && since && Date.now() - since >= 500) answer(true);
});
leave.addEventListener("click", () => answer(false));

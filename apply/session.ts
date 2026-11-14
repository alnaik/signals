// A form as you fill it: each read is kept until the page moves on or the tab closes, and then
// the answers you typed go to the bank. Shared by every way a form is filled.
import { saveAnswer } from "./answers.ts";
import { type Field, mapFields, type Question, typedAnswers } from "./forms.ts";
import { profile } from "./me.ts";

export type Seen = {
  // The form as last read, kept until the page moves on or closes; then its typed answers are saved.
  last: { path: string; company: string; questions: Question[]; fields: Field[] } | null;
};

/** Save what you typed on the form as last read (see typedAnswers), once. */
export function learn(st: Seen): number {
  const l = st.last;
  st.last = null;
  if (!l) return 0;
  const typed = typedAnswers(l.questions, l.fields, l.company);
  for (const t of typed) saveAnswer(t.question, l.company, t.answer);
  return typed.length;
}

/**
 * Keep a read of the form as what you typed; returns its fields. A new page means the last one
 * is done: its answers are saved. On the same page a read only adds: a form that submits in place
 * swaps its fields for a thank-you, so a question missing or empty now keeps the answer read before.
 */
export function capture(
  st: Seen,
  url: string,
  ctx: { company: string; cvFile: string | null },
  questions: Question[],
): Field[] {
  const company = ctx.company;
  const fields = mapFields(questions, { profile: profile(), company, cvFile: ctx.cvFile });
  const here = new URL(url).pathname;
  if (st.last && st.last.path !== here) learn(st);
  const seen = { path: here, company, questions: [...questions], fields: [...fields] };
  st.last?.questions.forEach((q, i) => {
    if (!q.value) return;
    const j = seen.questions.findIndex((n) => n.label === q.label);
    if (j < 0) {
      seen.questions.push(q);
      seen.fields.push(st.last!.fields[i]!);
    } else if (!seen.questions[j]!.value)
      seen.questions[j] = { ...seen.questions[j]!, value: q.value, ...(q.touched ? { touched: true } : {}) };
  });
  st.last = seen;
  return fields;
}

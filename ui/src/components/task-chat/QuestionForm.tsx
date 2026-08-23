import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type {
  PaperclipQuestionResponse,
  PaperclipQuestionSet,
} from "@paperclipai/adapter-utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Question = PaperclipQuestionSet["questions"][number];
type Answer = PaperclipQuestionResponse["answers"][string];

export interface QuestionFormProps {
  id: string;
  questionSet: PaperclipQuestionSet;
  initialResponse?: PaperclipQuestionResponse | null;
  implicitCustomAnswer?: boolean;
  disabled?: boolean;
  onSubmit: (response: PaperclipQuestionResponse) => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}

function answerHasValue(answer: Answer | undefined): boolean {
  return Boolean(answer?.text?.trim() || answer?.customText?.trim() || answer?.selectedOptionIds?.length);
}

function answerError(question: Question, answer: Answer | undefined): string | null {
  if (question.required && !answerHasValue(answer)) return "This question is required.";
  const value = question.answerMode === "text" ? answer?.text : answer?.customText;
  if (value == null || value.length === 0) return null;
  const validation = question.textValidation;
  if (validation?.minLength != null && value.length < validation.minLength) return `Enter at least ${validation.minLength} characters.`;
  if (validation?.maxLength != null && value.length > validation.maxLength) return `Enter no more than ${validation.maxLength} characters.`;
  if (validation?.pattern) {
    try {
      if (!new RegExp(validation.pattern).test(value)) return "Use the requested format.";
    } catch {
      return "This question has an invalid validation pattern.";
    }
  }
  if (validation?.inputType === "number" || validation?.inputType === "integer") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || (validation.inputType === "integer" && !Number.isInteger(numeric))) {
      return `Enter a valid ${validation.inputType}.`;
    }
    if (validation.minimum != null && numeric < validation.minimum) return `Enter a value of at least ${validation.minimum}.`;
    if (validation.maximum != null && numeric > validation.maximum) return `Enter a value no greater than ${validation.maximum}.`;
  }
  return null;
}

function SelectOption({
  id,
  label,
  description,
  selected,
  multiple,
  disabled,
  onClick,
}: {
  id: string;
  label: string;
  description?: string;
  selected: boolean;
  multiple: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      id={id}
      role={multiple ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-2 rounded-sm border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60",
        selected ? "border-primary/60 bg-primary/8" : "border-border/70 bg-background/50 hover:bg-muted/50",
      )}
      onClick={onClick}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
          multiple ? "rounded-sm" : "rounded-full",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50",
        )}
      >
        {selected ? (multiple ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />) : null}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-5 text-foreground">{label}</span>
        {description ? <span className="block text-xs leading-4 text-muted-foreground">{description}</span> : null}
      </span>
    </button>
  );
}

export function QuestionResponseSummary({
  questionSet,
  response,
}: {
  questionSet: PaperclipQuestionSet;
  response: PaperclipQuestionResponse;
}) {
  return (
    <dl className="grid gap-2 text-sm">
      {questionSet.questions.map((question) => {
        const answer = response.answers[question.id];
        const selectedLabels = (answer?.selectedOptionIds ?? []).map((optionId) =>
          question.options?.find((option) => option.id === optionId)?.label ?? optionId,
        );
        const values = [...selectedLabels, answer?.text, answer?.customText].filter((value): value is string => Boolean(value));
        return (
          <div key={question.id}>
            <dt className="text-xs font-medium text-muted-foreground">{question.header ?? question.prompt}</dt>
            <dd className="mt-0.5 text-foreground">{values.length > 0 ? values.join(", ") : "No answer"}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export function QuestionForm({
  id,
  questionSet,
  initialResponse,
  implicitCustomAnswer = false,
  disabled = false,
  onSubmit,
  onCancel,
}: QuestionFormProps) {
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => structuredClone(initialResponse?.answers ?? {}));
  const [customActive, setCustomActive] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(Object.entries(initialResponse?.answers ?? {}).filter(([, answer]) => Boolean(answer.customText)).map(([questionId]) => [questionId, true])),
  );
  const [working, setWorking] = useState<"submit" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(questionSet.questions.length - 1, 0)));
  }, [questionSet.questions.length]);

  const question = questionSet.questions[page];
  const validationErrors = useMemo(() => Object.fromEntries(
    questionSet.questions.map((candidate) => [candidate.id, answerError(candidate, answers[candidate.id])]),
  ), [answers, questionSet.questions]);
  const allValid = Object.values(validationErrors).every((value) => value == null);
  if (!question) return <p className="text-sm text-muted-foreground">No answerable questions were provided.</p>;
  const answer = answers[question.id] ?? {};
  const selected = answer.selectedOptionIds ?? [];
  const multiple = question.answerMode === "multi_select";
  const allowsCustom = question.answerMode !== "text" && (question.customAnswer?.enabled === true || implicitCustomAnswer);
  const isCustomActive = customActive[question.id] === true;

  function updateAnswer(next: Answer) {
    setAnswers((current) => ({ ...current, [question.id]: next }));
  }

  function toggleOption(optionId: string) {
    const optionIds = multiple
      ? selected.includes(optionId) ? selected.filter((candidate) => candidate !== optionId) : [...selected, optionId]
      : [optionId];
    updateAnswer({ ...answer, selectedOptionIds: optionIds, ...(!multiple ? { customText: undefined } : {}) });
    if (!multiple) setCustomActive((current) => ({ ...current, [question.id]: false }));
  }

  function toggleCustom() {
    const active = !isCustomActive;
    setCustomActive((current) => ({ ...current, [question.id]: active }));
    updateAnswer({
      ...answer,
      ...(!multiple && active ? { selectedOptionIds: [] } : {}),
      ...(!active ? { customText: undefined } : {}),
    });
  }

  async function submit() {
    if (!allValid || disabled || working) return;
    setWorking("submit");
    setError(null);
    try {
      await onSubmit({ schema: "paperclip.question_response.v1", answers: structuredClone(answers) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The answers could not be submitted.");
    } finally {
      setWorking(null);
    }
  }

  async function cancel() {
    if (!onCancel || disabled || working) return;
    setWorking("cancel");
    setError(null);
    try {
      await onCancel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The questions could not be cancelled.");
    } finally {
      setWorking(null);
    }
  }

  const currentError = validationErrors[question.id];
  return (
    <div>
      {questionSet.description && page === 0 ? <p className="mb-3 text-sm text-muted-foreground">{questionSet.description}</p> : null}
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Question {page + 1} of {questionSet.questions.length}</span>
        <span>{multiple ? "Choose all that apply" : question.answerMode === "text" ? "Write an answer" : "Choose one"}{question.required ? " · Required" : " · Optional"}</span>
      </div>
      {question.header ? <p className="mb-1 text-xs font-medium text-muted-foreground">{question.header}</p> : null}
      <p id={`${id}-${question.id}-prompt`} className="text-sm font-medium leading-5 text-foreground">{question.prompt}</p>
      {question.helpText ? <p className="mt-1 text-xs leading-4 text-muted-foreground">{question.helpText}</p> : null}
      {question.answerMode === "text" ? (
        <Textarea
          aria-labelledby={`${id}-${question.id}-prompt`}
          className="mt-3 min-h-20 resize-y bg-background text-sm"
          value={answer.text ?? ""}
          disabled={disabled || working != null}
          onChange={(event) => updateAnswer({ text: event.target.value })}
        />
      ) : (
        <div className="mt-3 grid gap-1.5" role={multiple ? "group" : "radiogroup"} aria-labelledby={`${id}-${question.id}-prompt`}>
          {(question.options ?? []).map((option) => (
            <SelectOption
              key={option.id}
              id={`${id}-${question.id}-${option.id}`}
              label={option.label}
              description={option.description}
              selected={selected.includes(option.id)}
              multiple={multiple}
              disabled={disabled || working != null}
              onClick={() => toggleOption(option.id)}
            />
          ))}
          {allowsCustom ? (
            <div className="space-y-1.5">
              <SelectOption
                id={`${id}-${question.id}-custom`}
                label={question.customAnswer?.label ?? "Other"}
                selected={isCustomActive}
                multiple={multiple}
                disabled={disabled || working != null}
                onClick={toggleCustom}
              />
              {isCustomActive ? (
                <Textarea
                  aria-label={`Other answer for ${question.prompt}`}
                  value={answer.customText ?? ""}
                  placeholder={question.customAnswer?.placeholder ?? "Type your answer"}
                  className="min-h-16 resize-y bg-background text-sm"
                  disabled={disabled || working != null}
                  onChange={(event) => updateAnswer({ ...answer, customText: event.target.value })}
                  autoFocus
                />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {currentError && answerHasValue(answer) ? <p className="mt-2 text-xs text-destructive">{currentError}</p> : null}
      <div aria-live="assertive">
        {error ? <div className="mt-2 rounded-sm border border-destructive/60 bg-destructive/10 px-2.5 py-2 text-sm text-destructive">{error}</div> : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-3">
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" disabled={disabled || working != null} onClick={() => void cancel()}>
            {working === "cancel" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null} Cancel
          </Button>
        ) : null}
        {page > 0 ? (
          <Button type="button" size="sm" variant="outline" disabled={disabled || working != null} onClick={() => setPage((current) => current - 1)}>
            <ChevronLeft aria-hidden className="h-4 w-4" /> Back
          </Button>
        ) : null}
        {page < questionSet.questions.length - 1 ? (
          <Button type="button" size="sm" disabled={disabled || working != null || validationErrors[question.id] != null} onClick={() => setPage((current) => current + 1)}>
            Next <ChevronRight aria-hidden className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="button" size="sm" disabled={disabled || working != null || !allValid} onClick={() => void submit()}>
            {working === "submit" ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
            {questionSet.submitLabel ?? "Submit answers"}
          </Button>
        )}
      </div>
    </div>
  );
}

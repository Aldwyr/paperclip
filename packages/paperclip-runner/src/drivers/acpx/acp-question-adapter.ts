import { createHash } from "node:crypto";

import type {
  AcpElicitationRequest,
  AcpElicitationResponse,
} from "acpx/runtime";

import {
  PAPERCLIP_QUESTION_SET_SCHEMA,
  parsePaperclipQuestionSet,
  parsePaperclipQuestionResponse,
  type PaperclipQuestion,
  type PaperclipQuestionOption,
  type PaperclipQuestionResponse,
  type PaperclipQuestionSet,
} from "../../contracts/question-set.js";

interface AcpFieldBinding {
  propertyName: string;
  property: Record<string, unknown>;
  question: PaperclipQuestion;
  optionValues: Map<string, string>;
}

export interface NormalizedAcpForm {
  questionSet: PaperclipQuestionSet;
  /** Convert a validated Paperclip response back into typed ACP content. */
  accept(response: unknown): AcpElicitationResponse;
}

/**
 * ACP remains private to this adapter. Only the normalized question set is
 * allowed to cross the Paperclip runtime-request boundary.
 */
export function normalizeAcpFormElicitation(
  request: AcpElicitationRequest,
): NormalizedAcpForm | null {
  const rawRequest = record(request);
  if (rawRequest.mode !== "form") return null;
  const schema = record(rawRequest.requestedSchema);
  const properties = record(schema.properties);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const bindings = Object.entries(properties).map(([propertyName, value], index) =>
    normalizeField(propertyName, value, index, required.has(propertyName)),
  );
  if (bindings.length === 0) {
    throw new Error("ACP form elicitation must define at least one supported property");
  }
  const title = optionalText(schema.title) ?? "Additional information needed";
  const descriptions = [optionalText(rawRequest.message), optionalText(schema.description)]
    .filter((value) => value !== title)
    .filter((value, position, all): value is string => Boolean(value) && all.indexOf(value) === position);
  const questionSet = parsePaperclipQuestionSet({
    schema: PAPERCLIP_QUESTION_SET_SCHEMA,
    title,
    ...(descriptions.length > 0 ? { description: descriptions.join("\n\n") } : {}),
    submitLabel: "Submit answers",
    questions: bindings.map((binding) => binding.question),
  });

  return {
    questionSet,
    accept(response: unknown): AcpElicitationResponse {
      const parsed = parsePaperclipQuestionResponse(questionSet, response);
      return {
        action: "accept",
        content: acpContent(bindings, parsed),
      };
    },
  };
}

function normalizeField(
  propertyName: string,
  value: unknown,
  index: number,
  required: boolean,
): AcpFieldBinding {
  const property = record(value);
  const type = text(property.type);
  const id = stableId("field", propertyName, index);
  const header = optionalText(property.title) ?? propertyName;
  const prompt = optionalText(property.description) ?? header;
  const base = {
    id,
    header,
    prompt,
    required,
  };

  if (type === "string") {
    const nativeOptions = enumOptions(property.oneOf ?? property.anyOf, property.enum);
    if (nativeOptions.length > 0) {
      const normalized = normalizeOptions(nativeOptions);
      return {
        propertyName,
        property,
        optionValues: normalized.values,
        question: {
          ...base,
          answerMode: "single_select",
          options: normalized.options,
        },
      };
    }
    return {
      propertyName,
      property,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: "text",
          ...(finiteNonNegativeInteger(property.minLength) !== undefined
            ? { minLength: finiteNonNegativeInteger(property.minLength) }
            : {}),
          ...(finiteNonNegativeInteger(property.maxLength) !== undefined
            ? { maxLength: finiteNonNegativeInteger(property.maxLength) }
            : {}),
          ...(optionalText(property.pattern) ? { pattern: optionalText(property.pattern) } : {}),
        },
      },
    };
  }

  if (type === "number" || type === "integer") {
    return {
      propertyName,
      property,
      optionValues: new Map(),
      question: {
        ...base,
        answerMode: "text",
        textValidation: {
          inputType: type,
          ...(finiteNumber(property.minimum) !== undefined ? { minimum: finiteNumber(property.minimum) } : {}),
          ...(finiteNumber(property.maximum) !== undefined ? { maximum: finiteNumber(property.maximum) } : {}),
        },
      },
    };
  }

  if (type === "boolean") {
    const options = [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ];
    const normalized = normalizeOptions(options);
    return {
      propertyName,
      property,
      optionValues: normalized.values,
      question: {
        ...base,
        answerMode: "single_select",
        options: normalized.options,
      },
    };
  }

  if (type === "array") {
    const items = record(property.items);
    const nativeOptions = enumOptions(items.anyOf ?? items.oneOf, items.enum);
    if (nativeOptions.length === 0) {
      throw new Error(`ACP multi-select property ${propertyName} must define enum or anyOf options`);
    }
    const normalized = normalizeOptions(nativeOptions);
    return {
      propertyName,
      property,
      optionValues: normalized.values,
      question: {
        ...base,
        answerMode: "multi_select",
        options: normalized.options,
      },
    };
  }

  throw new Error(`Unsupported ACP elicitation property type ${JSON.stringify(type)} for ${propertyName}`);
}

function acpContent(
  bindings: AcpFieldBinding[],
  response: PaperclipQuestionResponse,
): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const binding of bindings) {
    const answer = response.answers[binding.question.id];
    if (!answer) continue;
    const type = text(binding.property.type);
    if (type === "string" && binding.question.answerMode === "text") {
      if (answer.text !== undefined) content[binding.propertyName] = answer.text;
      continue;
    }
    if (type === "number" || type === "integer") {
      if (answer.text !== undefined) content[binding.propertyName] = Number(answer.text);
      continue;
    }
    if (type === "boolean") {
      const selected = answer.selectedOptionIds?.[0];
      if (selected !== undefined) content[binding.propertyName] = binding.optionValues.get(selected) === "true";
      continue;
    }
    const selectedValues = (answer.selectedOptionIds ?? []).map((id) => {
      const value = binding.optionValues.get(id);
      if (value === undefined) throw new Error(`ACP option ${id} is no longer available`);
      return value;
    });
    if (type === "array") content[binding.propertyName] = selectedValues;
    else if (selectedValues[0] !== undefined) content[binding.propertyName] = selectedValues[0];
  }
  return content;
}

function enumOptions(
  titled: unknown,
  values: unknown,
): Array<{ value: string; label: string; description?: string }> {
  if (Array.isArray(titled)) {
    return titled.map((entry, index) => {
      const option = record(entry);
      const value = requiredText(option.const, `ACP enum option ${index} const`);
      return {
        value,
        label: optionalText(option.title) ?? value,
        ...(optionalText(option.description) ? { description: optionalText(option.description) } : {}),
      };
    });
  }
  if (Array.isArray(values)) {
    return values.map((value, index) => {
      const native = requiredText(value, `ACP enum option ${index}`);
      return { value: native, label: native };
    });
  }
  return [];
}

function normalizeOptions(
  nativeOptions: Array<{ value: string; label: string; description?: string }>,
): { options: PaperclipQuestionOption[]; values: Map<string, string> } {
  const values = new Map<string, string>();
  const options = nativeOptions.map((option, index): PaperclipQuestionOption => {
    const id = stableId("option", option.value, index);
    if (values.has(id)) throw new Error(`ACP elicitation option identity collision for ${option.value}`);
    values.set(id, option.value);
    return {
      id,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    };
  });
  return { options, values };
}

function stableId(prefix: string, value: string, index: number): string {
  if (prefix === "field" && value.length > 0 && value.length <= 160) return value;
  if (prefix === "option") return `option-${index + 1}`;
  const readable = value.trim().replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${prefix}-${index + 1}-${readable || "value"}-${digest}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredText(value: unknown, field: string): string {
  const result = optionalText(value);
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

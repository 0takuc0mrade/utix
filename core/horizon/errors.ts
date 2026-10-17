/**
 * Shared Horizon failure taxonomy.
 *
 * Every feature that talks to Horizon maps transport failures through
 * `classifyHorizonError` so error handling stays identical across slices.
 */

export type HorizonErrorCode =
  | "not_found"
  | "rate_limited"
  | "bad_request"
  | "server_error"
  | "network_unavailable"
  | "timeout"
  | "unknown";

export interface HorizonErrorDetail {
  status?: number;
  title?: string;
  detail?: string;
}

export interface HorizonErrorClassification {
  code: HorizonErrorCode;
  detail: HorizonErrorDetail;
  retryable: boolean;
  safeMessage: string;
  correlationId: string;
}

function correlationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `hzn-${Math.random().toString(36).slice(2, 10)}`;
}

const safeMessages: Record<HorizonErrorCode, string> = {
  not_found: "The requested record was not found on this network.",
  rate_limited: "Horizon is temporarily rate limiting requests. Try again shortly.",
  bad_request: "Horizon rejected the request. Check the supplied value and try again.",
  server_error: "Horizon is temporarily unavailable. Try again shortly.",
  network_unavailable: "The network connection is unavailable. Check your connection and try again.",
  timeout: "Horizon did not respond in time. Try again.",
  unknown: "The request could not be completed. Try again or contact support with the correlation ID."
};

export function responseStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  if ("response" in error) {
    const response = (error as { response?: { status?: number } }).response;
    if (typeof response?.status === "number") return response.status;
  }

  if ("status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }

  return undefined;
}

export function classifyHorizonError(error: unknown): HorizonErrorClassification {
  const status = responseStatusOf(error);
  const detail: HorizonErrorDetail = { status };

  if (typeof error === "object" && error !== null && "response" in error) {
    const data = (error as { response?: { data?: { title?: string; detail?: string } } })
      .response?.data;
    if (data?.title) detail.title = redact(data.title) as string;
    if (data?.detail) detail.detail = redact(data.detail) as string;
  }

  let code: HorizonErrorCode = "unknown";
  if (status === 404) code = "not_found";
  else if (status === 429) code = "rate_limited";
  else if (status === 400 || status === 422) code = "bad_request";
  else if (typeof status === "number" && status >= 500) code = "server_error";

  if (code === "unknown") {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("abort") || message.includes("timeout")) code = "timeout";
    else if (message.includes("fetch") || message.includes("network")) code = "network_unavailable";
  }

  return {
    code,
    detail,
    retryable: code === "rate_limited" || code === "server_error" || code === "network_unavailable" || code === "timeout",
    safeMessage: safeMessages[code],
    correlationId: correlationId()
  };
}

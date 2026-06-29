export type AddressAdvice = {
  normalizedUrl: string;
  level: "ok" | "warning" | "error";
  message: string;
};

export function analyzeServerAddress(input: string): AddressAdvice {
  const normalizedUrl = input.trim().replace(/\/+$/, "");
  if (!normalizedUrl) {
    return { normalizedUrl, level: "error", message: "请先填写审批服务器地址。" };
  }

  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(normalizedUrl)) {
    return {
      normalizedUrl,
      level: "warning",
      message: "127.0.0.1 只代表当前电脑，同事电脑请填写服务端显示的局域网地址。"
    };
  }

  if (!/^https?:\/\/[^/]+(:\d+)?$/i.test(normalizedUrl)) {
    return { normalizedUrl, level: "error", message: "服务器地址格式不正确，应类似 http://192.168.1.20:8080。" };
  }

  return { normalizedUrl, level: "ok", message: "服务器地址格式正常。" };
}

export function isApiCompatible(input: { clientApiCompatVersion: number; serverApiCompatVersion: number }) {
  return input.clientApiCompatVersion === input.serverApiCompatVersion;
}

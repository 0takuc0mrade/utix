import * as realUtil from "node:util";

export const {
  _errnoException,
  _exceptionWithHostPort,
  _extend,
  callbackify,
  debug,
  debuglog,
  deprecate,
  format,
  formatWithOptions,
  getSystemErrorMap,
  getSystemErrorName,
  inherits,
  inspect,
  isArray,
  isBoolean,
  isBuffer,
  isDeepStrictEqual,
  isNull,
  isNullOrUndefined,
  isNumber,
  isObject,
  isPrimitive,
  isRegExp,
  isString,
  isSymbol,
  isUndefined,
  log,
  promisify,
  stripVTControlCharacters,
  toUSVString,
  types,
  TextDecoder,
  TextEncoder,
  MIMEType,
  MIMEParams
} = realUtil;

export function styleText(format, text) {
  return String(text);
}

export function parseEnv(content) {
  const result = {};
  if (typeof content !== "string") return result;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq !== -1) {
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }
  return result;
}

const utilShim = {
  ...realUtil,
  styleText,
  parseEnv
};

export default utilShim;

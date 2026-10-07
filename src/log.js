const fmt = (lvl, args) => [`${new Date().toISOString()} [${lvl}]`, ...args];
export const log = {
  info: (...a) => console.log(...fmt('INFO', a)),
  warn: (...a) => console.warn(...fmt('WARN', a)),
  error: (...a) => console.error(...fmt('ERROR', a)),
};

// Ambient type shims for assets that Expo / Metro resolve at bundle
// time but TypeScript doesn't natively understand.
//
// CSS modules + bare CSS imports are web-only — Metro ignores them
// on iOS/Android, but the TS compiler still tries to resolve them
// when checking *.web.tsx files. The shims below tell tsc "trust me,
// these resolve at runtime."

declare module '*.css';
declare module '*.module.css' {
  const styles: Record<string, string>;
  export default styles;
}

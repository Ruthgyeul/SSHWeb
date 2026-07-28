// eslint-config-next 16 ships flat config directly. Wrapping it in FlatCompat
// introduces a circular reference that trips the validation step, so we spread
// the presets straight in.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
];

export default eslintConfig;

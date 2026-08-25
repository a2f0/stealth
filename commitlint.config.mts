import conventionalConfig from "@commitlint/config-conventional";
import {
  commitHeaderMaxLength,
  commitTypes,
} from "./packages/agent-tool/src/pr/commitPolicy";

const conventionalTypes = conventionalConfig.rules["type-enum"][2];
const expectedTypes = new Set([...conventionalTypes, "cleanup"]);
if (
  expectedTypes.size !== commitTypes.length ||
  commitTypes.some((type) => !expectedTypes.has(type))
) {
  throw new Error("The trusted commit policy types are out of sync.");
}

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", commitTypes],
    "header-max-length": [2, "always", commitHeaderMaxLength],
  },
};

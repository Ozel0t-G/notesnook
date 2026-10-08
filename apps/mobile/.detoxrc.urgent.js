const base = require("./.detoxrc.js");
module.exports = {
  ...base,
  testRunner: {
    ...base.testRunner,
    args: { ...base.testRunner.args, config: "e2e/jest.urgent.config.js" }
  }
};

const assert = require("node:assert/strict");

const XMLParser = {
  parse(source) {
    const rootMatch = source.match(/<([A-Za-z0-9:_-]+)\s+([^>]*?)>/s);
    assert.ok(rootMatch, "XML root element not found");

    return {
      root: {
        name: rootMatch[1],
        attributes: this.attributes(rootMatch[2])
      }
    };
  },

  attributes(source) {
    const attributes = {};
    const pattern = /([A-Za-z0-9:_-]+)="([^"]*)"/g;
    let match;

    while ((match = pattern.exec(source))) {
      attributes[match[1]] = match[2];
    }

    return attributes;
  }
};

module.exports = { XMLParser };

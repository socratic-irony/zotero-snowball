var SnowballUtil = {
  chunk(items, size) {
    if (!Array.isArray(items) || size <= 0) {
      return [];
    }

    const chunks = [];

    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }

    return chunks;
  },

  normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  },

  formatScore(score) {
    return Math.round((score || 0) * 100);
  }
};

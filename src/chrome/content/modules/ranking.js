var SnowballRanking = {
  scoreCandidates(candidates, seedRecords) {
    const seedVector = this.buildSeedVector(seedRecords);

    for (const candidate of candidates) {
      this.scoreCandidate(candidate, seedVector);
    }

    return candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
  },

  buildSeedVector(seedRecords) {
    const seedText = seedRecords
      .map(seed => `${seed.title || ""} ${seed.abstract || ""}`)
      .join(" ");
    return this.termVector(seedText);
  },

  scoreCandidate(candidate, seedVector) {
    const candidateText = `${candidate.title || ""} ${candidate.abstract || ""}`;
    const candidateVector = this.termVector(candidateText);

    const similarity = this.cosine(seedVector, candidateVector);
    const citationBoost = Math.log10((candidate.citedByCount || 0) + 1) / 10;
    const abstractPenalty = candidate.abstract ? 0 : -0.05;
    const duplicatePenalty = candidate.alreadyInLibrary ? -0.35 : 0;
    const directionBoost = candidate.direction === "both" ? 0.1 : 0;

    candidate.relevanceScore = Math.max(
      0,
      similarity + citationBoost + abstractPenalty + duplicatePenalty + directionBoost
    );

    return candidate;
  },

  termVector(text) {
    const vector = new Map();

    for (const token of this.tokenize(text)) {
      vector.set(token, (vector.get(token) || 0) + 1);
    }

    return vector;
  },

  tokenize(text) {
    const stop = new Set([
      "the", "and", "for", "with", "that", "this", "from", "are", "was",
      "were", "have", "has", "had", "not", "but", "can", "may", "using",
      "use", "used", "into", "their", "there", "these", "those", "than",
      "study", "paper", "article"
    ]);

    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(token => token.length > 2 && !stop.has(token));
  },

  cosine(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (const value of a.values()) {
      normA += value * value;
    }

    for (const value of b.values()) {
      normB += value * value;
    }

    for (const [key, value] of a.entries()) {
      dot += value * (b.get(key) || 0);
    }

    if (!normA || !normB) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
};

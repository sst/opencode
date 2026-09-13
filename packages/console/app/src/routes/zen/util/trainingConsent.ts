export function requiresGoTrainingConsent(model: string) {
  return ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"].includes(model)
}

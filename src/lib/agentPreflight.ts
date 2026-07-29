export async function readAgentPreflight<V, R, L, A>(input: {
  verdict: () => Promise<V>;
  persistVerdict: (value: V) => Promise<void>;
  resumeAudit: () => Promise<R>;
  libraryIds: () => Promise<L>;
  attachments: () => Promise<A>;
}): Promise<{
  verdict: V;
  resumeAudit: R;
  libraryIds: L;
  attachments: A;
}> {
  const verdict = input.verdict().then(async (value) => {
    await input.persistVerdict(value);
    return value;
  });
  const [frozenVerdict, resumeAudit, libraryIds, attachments] =
    await Promise.all([
      verdict,
      input.resumeAudit(),
      input.libraryIds(),
      input.attachments(),
    ]);
  return {
    verdict: frozenVerdict,
    resumeAudit,
    libraryIds,
    attachments,
  };
}

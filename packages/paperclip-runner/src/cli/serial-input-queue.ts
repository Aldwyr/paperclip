export function enqueueSerialInput(
  pending: Promise<void>,
  operation: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  return pending.then(operation).catch((error) => {
    onError(error);
  });
}

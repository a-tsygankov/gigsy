/**
 * Reading and writing user settings (Phase 11).
 *
 * One hook, because every section needs the same three things: the
 * current values, a way to change one, and whether a change is in
 * flight. Splitting it per section would mean a query per section and
 * a settings screen that flickers in pieces.
 *
 * Writes are optimistic. A toggle that waits for a round trip before
 * moving feels broken on a phone, and the cost of being wrong is that
 * one preference snaps back — which the error message then explains.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useData } from "../../lib/app-context.tsx";
import type { Settings, SettingsPatch } from "../../lib/settings-schema.ts";

export const SETTINGS_KEY = ["settings"] as const;

export function useSettings() {
  const data = useData();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => data.getSettings(),
  });

  const mutation = useMutation({
    mutationFn: (patch: SettingsPatch) => data.updateSettings(patch),
    onMutate: async (patch) => {
      // Stop an in-flight refetch from overwriting the optimistic value.
      await queryClient.cancelQueries({ queryKey: SETTINGS_KEY });
      const previous = queryClient.getQueryData<Settings>(SETTINGS_KEY);
      if (previous !== undefined) {
        queryClient.setQueryData<Settings>(SETTINGS_KEY, { ...previous, ...patch });
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      // Put it back: a control showing a value the server rejected is
      // worse than one that visibly snaps back.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(SETTINGS_KEY, context.previous);
      }
    },
    // The server returns the merged result, so trust it over the guess.
    onSuccess: (settings) => queryClient.setQueryData(SETTINGS_KEY, settings),
  });

  return {
    settings: query.data,
    isLoading: query.isLoading,
    loadError: query.error,
    update: (patch: SettingsPatch) => mutation.mutate(patch),
    /** Like `update`, but awaitable and rejecting. For the one caller
     *  that must not proceed unless the write actually landed: the
     *  invoice number is printed on a document, so a rolled-back
     *  counter would be reused. */
    updateAsync: (patch: SettingsPatch) => mutation.mutateAsync(patch),
    isSaving: mutation.isPending,
    saveError: mutation.error,
  };
}

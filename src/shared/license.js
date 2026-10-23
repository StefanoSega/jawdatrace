/**
 * Marketplace licensing (manifest: app.licensing.enabled).
 *
 * Forge puts a `license` object in the context of every resolver call and
 * every UI module (useProductContext). Its shape: { active, isEvaluation,
 * trialEndDate, ... }.
 *
 * The rule, shared by the UI and the resolvers:
 *  - license present and active === false -> blocked (expired or cancelled
 *    subscription, ended trial)
 *  - license present and active           -> allowed (paid or in trial)
 *  - no license object                    -> allowed: Forge only sends one
 *    for Marketplace installations of a paid app, so development and
 *    staging environments and direct installs (forge install) work as before
 *
 * The resolvers are the real gate: the UI check only shows a friendly
 * message instead of panels that would fail anyway.
 */
export function isLicenseInactive(license) {
  return Boolean(license) && license.active === false;
}

export const LICENSE_MESSAGE =
  'The jawdatrace license for this site is not active. Ask a Jira administrator to renew it in Manage apps.';

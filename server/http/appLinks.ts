/**
 * Universal and app links: the files that let iOS and Android open https://cyberkiwi.app/story/<id> in the app.
 *
 *   /.well-known/apple-app-site-association   iOS Associated Domains
 *   /.well-known/assetlinks.json              Android verified App Links
 *
 * The files need real values (the Apple team ID and the Android release signing certificate SHA-256). Until those
 * are configured, the routes return 404. A file with placeholder values would look deployed and would not work.
 */
import { Router, type Request, type Response } from 'express';

export interface AppLinkConfig {
  appleTeamId?: string;
  iosBundleId?: string;
  androidPackage?: string;
  /** Release signing certificate fingerprint, colon-separated uppercase hex (as printed by keytool). */
  androidSha256?: string;
}

const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9.-]+$/;
const SHA256_FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function appLinkConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppLinkConfig {
  return {
    appleTeamId: env.APPLE_TEAM_ID?.trim() || undefined,
    iosBundleId: env.IOS_BUNDLE_ID?.trim() || 'com.cyberkiwi.client',
    androidPackage: env.ANDROID_PACKAGE?.trim() || 'com.cyberkiwi.client',
    androidSha256: env.ANDROID_CERT_SHA256?.trim() || undefined,
  };
}

/** The iOS association file, or null when the team ID is missing or malformed. */
export function buildAppleAppSiteAssociation(config: AppLinkConfig): object | null {
  if (!config.appleTeamId || !TEAM_ID.test(config.appleTeamId)) return null;
  if (!config.iosBundleId || !BUNDLE_ID.test(config.iosBundleId)) return null;
  const appID = `${config.appleTeamId}.${config.iosBundleId}`;
  return {
    applinks: {
      apps: [],
      details: [{ appID, appIDs: [appID], components: [{ '/': '/story/*', comment: 'Story links' }] }],
    },
  };
}

/** The Android asset links file, or null when the package or the certificate fingerprint is missing. */
export function buildAssetLinks(config: AppLinkConfig): object[] | null {
  if (!config.androidPackage || !BUNDLE_ID.test(config.androidPackage)) return null;
  if (!config.androidSha256 || !SHA256_FINGERPRINT.test(config.androidSha256)) return null;
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: config.androidPackage,
        sha256_cert_fingerprints: [config.androidSha256],
      },
    },
  ];
}

export function appLinkRoutes(config: AppLinkConfig): Router {
  const router = Router();
  const serve = (build: () => object | object[] | null) => (_req: Request, res: Response) => {
    const body = build();
    if (!body) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', 'application/json');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(JSON.stringify(body));
  };
  router.get('/.well-known/apple-app-site-association', serve(() => buildAppleAppSiteAssociation(config)));
  router.get('/.well-known/assetlinks.json', serve(() => buildAssetLinks(config)));
  return router;
}

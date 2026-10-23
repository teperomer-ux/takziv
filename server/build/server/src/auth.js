import { adminAuth } from "./firebaseAdmin.js";
import { sendError } from "./errors.js";
/**
 * Verifies the Firebase ID token sent as `Authorization: Bearer <token>` and
 * requires that the session came from Google sign-in. On success the user's
 * uid is available as `res.locals.uid`.
 */
export async function requireGoogleUser(req, res, next) {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!match)
        return sendError(res, "UNAUTHENTICATED");
    try {
        // checkRevoked=true rejects tokens of users who signed out everywhere / were disabled.
        const decoded = await adminAuth.verifyIdToken(match[1], true);
        if (decoded.firebase.sign_in_provider !== "google.com")
            return sendError(res, "FORBIDDEN");
        res.locals.uid = decoded.uid;
        next();
    }
    catch {
        sendError(res, "UNAUTHENTICATED");
    }
}

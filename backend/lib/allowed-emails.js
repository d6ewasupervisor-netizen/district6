// backend/lib/allowed-emails.js
//
// Email access control for the District 6 Compliance Hub.
//
// Two ways to be allowed:
//   1. Email ends in @retailodyssey.com (the corporate domain), OR
//   2. Email is in ALLOWED_EMAILS below (personal addresses for direct reports
//      whose work accounts live on other domains: gmail, yahoo, icloud, etc.)
//
// Adding someone: drop their lowercase email into the array, alphabetized by
// surname. Removing someone: delete the line. The hub redeploys on push.
//
// Phase 2 will replace this with a database-backed admin UI.

const CORPORATE_DOMAIN = 'retailodyssey.com';

// Lowercase. Trailing comments help future-you remember who is who.
const ALLOWED_EMAILS = new Set([
  'ajcobiskey@gmail.com',                       // Andrea Cobiskey
  'jaxonbarbee2004@gmail.com',                  // Jaxon Barbee
  'monique.perez73@yahoo.com',                  // Monique Barron Perez
  'bruce.brennick@youradv.com',                 // Bruce Brennick
  'ryan.baysinger@youradv.com',                 // Ryan Baysinger
  'samantha.capps@youradv.com',                 // Samantha Capps
  'cindy.roth@sasretailservices.com',           // Cindy Roth
  'dennis.baker@sasretailservices.com',         // Dennis Baker III
  'kasi.sleater@sasretailservices.com',         // Kasi Sleater
  'stephen.lincoln@sasretailservices.com',      // Stephen Lincoln
  'lily.thiphakhinkeo@sasretailservices.com',   // Vikanda Thiphakhinkeo
  'brady.looyenga@gmail.com',                   // Brady Looyenga
  'chancefsss@gmail.com',                       // Chance Ward
  'newmng2024@gmail.com',                       // Clinton Williams
  'davidwadeward@yahoo.com',                    // David Ward
  'jaxpond8@gmail.com',                         // Jacqueline Pond
  'lukelucey1971@gmail.com',                    // Jeffie Reber
  'tsteinertjerry@yahoo.com',                   // Jerry Steinert
  'kaydencesmith2006@icloud.com',               // Kaydence Smith
  'kelly.c.martin614@gmail.com',                // Kelly Martin
  'ojoya18@gmail.com',                          // Oscar Joya Rodriguez
  'tiffanypond04@gmail.com',                    // Tiffany Pond
  'tinaloera1970@gmail.com',                    // Tina Loera
]);

/**
 * @param {string} email - Already trimmed; will be lowercased here.
 * @returns {boolean}
 */
export function isEmailAllowed(email) {
  if (typeof email !== 'string' || !email) return false;
  const normalized = email.trim().toLowerCase();
  if (normalized.endsWith('@' + CORPORATE_DOMAIN)) return true;
  return ALLOWED_EMAILS.has(normalized);
}

export const _internal = { ALLOWED_EMAILS, CORPORATE_DOMAIN };

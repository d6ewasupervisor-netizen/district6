-- Personal email allowlist for requesting compliance links (addresses not on approved work domains).
-- Work domains (e.g. @retailodyssey.com, @sasretailservices.com) are always allowed by application logic — do not insert them here.
CREATE TABLE IF NOT EXISTS allowed_emails (
  email TEXT PRIMARY KEY,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_allowed_emails_updated_at ON allowed_emails(updated_at DESC);

INSERT INTO allowed_emails (email, note) VALUES
  ('ajcobiskey@gmail.com', 'Andrea Cobiskey'),
  ('jaxonbarbee2004@gmail.com', 'Jaxon Barbee'),
  ('monique.perez73@yahoo.com', 'Monique Barron Perez'),
  ('bruce.brennick@youradv.com', 'Bruce Brennick'),
  ('ryan.baysinger@youradv.com', 'Ryan Baysinger'),
  ('samantha.capps@youradv.com', 'Samantha Capps'),
  ('cindy.roth@sasretailservices.com', 'Cindy Roth'),
  ('dennis.baker@sasretailservices.com', 'Dennis Baker III'),
  ('kasi.sleater@sasretailservices.com', 'Kasi Sleater'),
  ('stephen.lincoln@sasretailservices.com', 'Stephen Lincoln'),
  ('lily.thiphakhinkeo@sasretailservices.com', 'Vikanda Thiphakhinkeo'),
  ('brady.looyenga@gmail.com', 'Brady Looyenga'),
  ('chancefsss@gmail.com', 'Chance Ward'),
  ('newmng2024@gmail.com', 'Clinton Williams'),
  ('davidwadeward@yahoo.com', 'David Ward'),
  ('jaxpond8@gmail.com', 'Jacqueline Pond'),
  ('lukelucey1971@gmail.com', 'Jeffie Reber'),
  ('tsteinertjerry@yahoo.com', 'Jerry Steinert'),
  ('kaydencesmith2006@icloud.com', 'Kaydence Smith'),
  ('kelly.c.martin614@gmail.com', 'Kelly Martin'),
  ('ojoya18@gmail.com', 'Oscar Joya Rodriguez'),
  ('tiffanypond04@gmail.com', 'Tiffany Pond'),
  ('tinaloera1970@gmail.com', 'Tina Loera'),
  ('tgauthier2011@gmail.com', 'Tyson Gauthier')
ON CONFLICT (email) DO NOTHING;

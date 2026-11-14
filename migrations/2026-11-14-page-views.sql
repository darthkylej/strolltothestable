-- Additive migration: does not modify existing application tables.
CREATE TABLE IF NOT EXISTS page_view_daily (
  view_date DATE NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('site', 'tour')),
  views BIGINT NOT NULL DEFAULT 0 CHECK (views >= 0),
  PRIMARY KEY (view_date, category)
);
-- "site" counts public pages other than the virtual tour; "tour" counts the tour.
-- Overall website page views = site + tour.

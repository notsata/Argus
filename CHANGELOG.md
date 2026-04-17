# Changelog

## [1.1.2] — 2026-04-16

### Improvements

- **History tab pre-fill**: Portfolio History now loads the same 1-year reconstructed data as the main chart. Previously the History tab showed only recorded daily snapshots, leaving it empty on first launch.
- **Y-axis slider range**: Slider travel is now capped at ±50% of the portfolio's data span rather than a fixed ±$10,000. The zoom range scales proportionally with portfolio size.
- **Yahoo Finance timeout**: All Yahoo Finance requests now time out after 10 seconds. Previously a slow or unresponsive connection would leave the app stuck on the loading screen indefinitely.
- **Candle chart data source**: Candlestick chart now always draws from the full daily dataset, ensuring genuine OHLC spread regardless of which D/W/M/Y frequency is selected.

### Security

- Rate limit added to the portfolio reset endpoint (5 requests per minute) to prevent denial-of-service via rapid file system operations.

---

## [1.1.1] — 2026-04-16

### Portfolio Chart — Major Overhaul

- **Historical pre-fill**: Chart is now populated with up to 1 year of reconstructed portfolio value history on first launch, using daily closing prices from Yahoo Finance. Previously the chart was empty until daily snapshots accumulated.
- **Real-time in-place updates**: Chart refreshes smoothly every 60 seconds without flickering or re-creating the canvas. All four chart types (Area, Line, Candle, Bar) update in place with a 220ms transition.
- **Live dot indicator**: A glowing dot marks the latest data point, indicating the chart reflects live prices.
- **Data frequency selector**: New D / W / M / Y buttons above the chart resample data into daily, weekly, monthly, or yearly buckets.
- **Y-axis zoom & pan**:
  - Left-side slider rail with two draggable thumbs to set the visible high and low bounds independently.
  - Drag the fill bar between thumbs to pan the entire Y-axis window.
  - Drag directly on the chart canvas to pan up or down.
  - Bounds are clamped to ±$10,000 beyond the portfolio's all-time high and low.
  - 🔍 Reset button restores the auto-fit view.
- **Chart height increased** by 15%.
- **Candle chart fix**: Candlestick chart now builds proper OHLC bodies with real high/low spread. Previously candles collapsed to single lines because each bucket contained only one data point. The chart now groups raw daily data into calendar periods (daily / weekly / monthly depending on the selected time span) so each candle has genuine open, high, low, and close values.

### Bug Fixes

- Hover tooltip on the portfolio chart now shows the correct gain/loss percentage after adding or removing a position. Previously, the baseline used for hover calculations was not updated when holdings changed.
- Yahoo Finance requests no longer fail silently after an auth token expires. On a 401 response the session token is cleared, re-authentication runs automatically, and the request is retried once.
- Fixed "Macha" → "Matcha" label in the Settings theme selector.

---

## [1.0.1] — Initial Release

- Live portfolio tracking with real-time Yahoo Finance quotes
- Holdings table with sortable columns, weight bars, and unrealized gain/loss
- Portfolio chart (Area, Line, Candle, Bar) with period selector (1W – ALL)
- Add Calculator for simulating position adds
- Earnings Calendar with countdown timers
- Concentration Monitor with configurable threshold alerts
- Dip Alert Screener (50d MA, 200d MA, RSI-14)
- Market Heatmap (110 S&P 500 stocks across 11 sectors)
- History tab with SPY and QQQ benchmark comparison
- News Feed (Yahoo Finance headlines per holding)
- Price Alerts with Windows desktop notifications
- CSV import (Fidelity, Schwab, Robinhood)
- AES-256-GCM encryption with Windows DPAPI key protection
- Silent auto-updates via GitHub Releases

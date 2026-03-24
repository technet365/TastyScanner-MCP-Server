// ============================================================================
// TastyScanner MCP — Strategy Builder (all 12 strategies)
// Server-side replication of src/app/models/strategies-builder.ts
//
// Credit strategies (sell premium, positive theta):
//   1. Iron Condor         — put spread + call spread, different short strikes
//   2. Put Credit Spread   — STO put + BTO put below
//   3. Call Credit Spread  — STO call + BTO call above
//   4. Iron Butterfly      — like IC but short strikes at same ATM price
//   5. Jade Lizard         — naked STO put + call credit spread (zero upside risk)
//   6. Twisted Sister      — naked STO call + put credit spread (zero downside risk)
//
// Debit strategies (buy premium, negative theta):
//   7. Long Straddle       — BTO put + BTO call at same strike
//   8. Long Strangle       — BTO put + BTO call at different OTM strikes
//   9. Bull Call Spread    — BTO call (lower) + STO call (higher)
//  10. Bear Put Spread     — BTO put (higher) + STO put (lower)
//  11. Call Butterfly       — BTO lower + 2×STO mid + BTO upper (calls)
//  12. Put Butterfly        — BTO lower + 2×STO mid + BTO upper (puts)
//
// GREEKS SIGN CONVENTION:
//   DxLink returns greeks from the option holder's perspective (long position):
//     - Long put:  delta < 0, theta < 0
//     - Long call: delta > 0, theta < 0
//   For position greeks:
//     - BTO (long):  use raw greek value  (+1 × greek)
//     - STO (short): negate raw greek     (-1 × greek)
//   Credit strategies should have: positive theta, near-zero delta
//   Debit strategies should have:  negative theta
// ============================================================================

import { TastyClient } from "./tasty-client.js";
import { StrategySetup, StrategyLeg } from "./types.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Strategy type enum — matches what DeerFlow can request
// ---------------------------------------------------------------------------

export type StrategyType =
  | "all"
  | "iron_condor"
  | "put_credit_spread"
  | "call_credit_spread"
  | "iron_butterfly"
  | "jade_lizard"
  | "twisted_sister"
  | "long_straddle"
  | "long_strangle"
  | "bull_call_spread"
  | "bear_put_spread"
  | "call_butterfly"
  | "put_butterfly";

// ---------------------------------------------------------------------------
// Configuration defaults (mirrors main app's strategy-settings)
// ---------------------------------------------------------------------------

export interface StrategyFilterConfig {
  minDelta: number;        // 0.10 — credit strategy short strike min delta
  maxDelta: number;        // 0.30 — credit strategy short strike max delta
  debitMinDelta: number;   // 0.30 — debit strategy long strike min delta
  debitMaxDelta: number;   // 0.50 — debit strategy long strike max delta
  wings: number[];         // [1, 2, 3, 5, 10]
  condorsMinDelta: number; // -5
  condorsMaxDelta: number; // 5
  maxBidAskSpread: number; // 0.50
  minDTE: number;          // 20
  maxDTE: number;          // 60
}

const DEFAULT_FILTERS: StrategyFilterConfig = {
  minDelta: 0.10,
  maxDelta: 0.30,
  debitMinDelta: 0.30,
  debitMaxDelta: 0.50,
  wings: [1, 2, 3, 5, 10],
  condorsMinDelta: -5,
  condorsMaxDelta: 5,
  maxBidAskSpread: 0.50,
  minDTE: 20,
  maxDTE: 60,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedStrike {
  strikePrice: number;
  callSymbol: string;
  putSymbol: string;
  callStreamer: string;
  putStreamer: string;
}

interface ParsedExpiration {
  expirationDate: string;
  daysToExpiration: number;
  expirationType: string;
  strikes: ParsedStrike[];
}

interface OptionData {
  symbol: string;
  streamerSymbol: string;
  strikePrice: number;
  type: "Put" | "Call";
  expirationDate: string;
  dte: number;
  bidPrice: number;
  askPrice: number;
  midPrice: number;
  delta: number;
  absDelta: number;
  theta: number;
  bidAskSpread: number;
}

interface CreditSpread {
  stoOption: OptionData;
  btoOption: OptionData;
  wingsWidth: number;
  credit: number;
  riskRewardRatio: number;
  delta: number;
  theta: number;
  type: "put" | "call";
}

// ---------------------------------------------------------------------------
// StrategyBuilder
// ---------------------------------------------------------------------------

export class StrategyBuilder {
  private filters: StrategyFilterConfig;

  constructor(
    private tastyClient: TastyClient,
    filters?: Partial<StrategyFilterConfig>,
  ) {
    this.filters = { ...DEFAULT_FILTERS, ...filters };
  }

  /**
   * Build strategies for a given symbol and type.
   * If type="all", builds all 12 strategy types.
   */
  async buildStrategies(
    symbol: string,
    strategyType: StrategyType = "all",
  ): Promise<StrategySetup[]> {
    logger.info(`[StrategyBuilder] Building ${strategyType} for ${symbol}`);

    const rawChain = await this.tastyClient.getOptionsChain(symbol);
    if (!rawChain) {
      logger.warn(`[StrategyBuilder] No options chain for ${symbol}`);
      return [];
    }

    const expirations = this._parseChain(rawChain);
    const validExpirations = expirations.filter(
      (exp) =>
        exp.daysToExpiration >= this.filters.minDTE &&
        exp.daysToExpiration <= this.filters.maxDTE,
    );

    logger.info(
      `[StrategyBuilder] ${validExpirations.length} expirations in DTE [${this.filters.minDTE}-${this.filters.maxDTE}]`,
    );

    // Subscribe to streamer and wait for data
    const allStreamerSymbols: string[] = [];
    for (const exp of validExpirations) {
      for (const strike of exp.strikes) {
        allStreamerSymbols.push(strike.callStreamer, strike.putStreamer);
      }
    }
    if (allStreamerSymbols.length > 0) {
      await this.tastyClient.subscribeToSymbols(allStreamerSymbols);
      await this._waitForData(allStreamerSymbols.slice(0, 10), 5000);
    }

    // Build per expiration
    const allStrategies: StrategySetup[] = [];

    for (const exp of validExpirations) {
      const puts = this._buildOptionDataList(exp, "Put");
      const calls = this._buildOptionDataList(exp, "Call");

      // Credit-filtered options (delta 0.10-0.30)
      const creditPuts = this._filterByDelta(puts, this.filters.minDelta, this.filters.maxDelta);
      const creditCalls = this._filterByDelta(calls, this.filters.minDelta, this.filters.maxDelta);

      // Debit-filtered options (delta 0.30-0.50)
      const debitPuts = this._filterByDelta(puts, this.filters.debitMinDelta, this.filters.debitMaxDelta);
      const debitCalls = this._filterByDelta(calls, this.filters.debitMinDelta, this.filters.debitMaxDelta);

      // Credit spreads (foundation for IC, IB, JL, TS)
      const putSpreads = this._buildCreditSpreads(creditPuts, exp.strikes, "put");
      const callSpreads = this._buildCreditSpreads(creditCalls, exp.strikes, "call");

      // ── Credit strategies ──

      if (strategyType === "all" || strategyType === "put_credit_spread") {
        for (const ps of putSpreads) {
          allStrategies.push(this._toPutCreditSpread(ps, exp));
        }
      }

      if (strategyType === "all" || strategyType === "call_credit_spread") {
        for (const cs of callSpreads) {
          allStrategies.push(this._toCallCreditSpread(cs, exp));
        }
      }

      if (strategyType === "all" || strategyType === "iron_condor") {
        allStrategies.push(...this._buildIronCondors(putSpreads, callSpreads, exp));
      }

      if (strategyType === "all" || strategyType === "iron_butterfly") {
        allStrategies.push(...this._buildIronButterflies(putSpreads, callSpreads, exp));
      }

      if (strategyType === "all" || strategyType === "jade_lizard") {
        allStrategies.push(...this._buildJadeLizards(creditPuts, callSpreads, exp));
      }

      if (strategyType === "all" || strategyType === "twisted_sister") {
        allStrategies.push(...this._buildTwistedSisters(creditCalls, putSpreads, exp));
      }

      // ── Debit strategies ──

      if (strategyType === "all" || strategyType === "long_straddle") {
        allStrategies.push(...this._buildLongStraddles(debitPuts, debitCalls, exp));
      }

      if (strategyType === "all" || strategyType === "long_strangle") {
        allStrategies.push(...this._buildLongStrangles(debitPuts, debitCalls, exp));
      }

      if (strategyType === "all" || strategyType === "bull_call_spread") {
        allStrategies.push(...this._buildBullCallSpreads(debitCalls, exp));
      }

      if (strategyType === "all" || strategyType === "bear_put_spread") {
        allStrategies.push(...this._buildBearPutSpreads(debitPuts, exp));
      }

      if (strategyType === "all" || strategyType === "call_butterfly") {
        allStrategies.push(...this._buildCallButterflies(creditCalls, exp));
      }

      if (strategyType === "all" || strategyType === "put_butterfly") {
        allStrategies.push(...this._buildPutButterflies(creditPuts, exp));
      }
    }

    allStrategies.sort((a, b) => a.rr_ratio - b.rr_ratio);

    logger.info(`[StrategyBuilder] Found ${allStrategies.length} setups for ${symbol} (${strategyType})`);
    return allStrategies;
  }

  // =========================================================================
  // Credit strategy builders
  // =========================================================================

  private _toPutCreditSpread(ps: CreditSpread, exp: ParsedExpiration): StrategySetup {
    const maxLoss = round(ps.wingsWidth - ps.credit);
    // BPE for put credit spread = short put strike - credit received
    const bpe = round(ps.stoOption.strikePrice - ps.credit);
    return {
      strategy_name: "Put Credit Spread",
      expiry_date: exp.expirationDate,
      dte: exp.daysToExpiration,
      legs: [
        this._leg("BTO", "Put", ps.btoOption),
        this._leg("STO", "Put", ps.stoOption),
      ],
      credit: ps.credit,
      max_profit: ps.credit,
      max_loss: maxLoss,
      // RR = max_loss / max_profit (how much you risk per $1 of profit)
      rr_ratio: round(maxLoss / ps.credit),
      pop: round(100 - ps.stoOption.absDelta * 100),
      // Greeks already have correct position signs from _buildCreditSpreads
      theta: ps.theta,
      delta: ps.delta,
      wings: ps.wingsWidth,
      bpe,
      price_effect: "Credit",
    };
  }

  private _toCallCreditSpread(cs: CreditSpread, exp: ParsedExpiration): StrategySetup {
    const maxLoss = round(cs.wingsWidth - cs.credit);
    // BPE for call credit spread = short call strike + credit received
    const bpe = round(cs.stoOption.strikePrice + cs.credit);
    return {
      strategy_name: "Call Credit Spread",
      expiry_date: exp.expirationDate,
      dte: exp.daysToExpiration,
      legs: [
        this._leg("STO", "Call", cs.stoOption),
        this._leg("BTO", "Call", cs.btoOption),
      ],
      credit: cs.credit,
      max_profit: cs.credit,
      max_loss: maxLoss,
      rr_ratio: round(maxLoss / cs.credit),
      pop: round(100 - cs.stoOption.absDelta * 100),
      theta: cs.theta,
      delta: cs.delta,
      wings: cs.wingsWidth,
      bpe,
      price_effect: "Credit",
    };
  }

  private _buildIronCondors(
    putSpreads: CreditSpread[],
    callSpreads: CreditSpread[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    const putByWings = groupBy(putSpreads, (s) => s.wingsWidth.toString());
    const callByWings = groupBy(callSpreads, (s) => s.wingsWidth.toString());

    for (const wing of Object.keys(putByWings)) {
      const pGroup = putByWings[wing];
      const cGroup = callByWings[wing];
      if (!cGroup) continue;
      for (const ps of pGroup) {
        for (const cs of cGroup) {
          const credit = round(ps.credit + cs.credit);
          const wings = ps.wingsWidth;
          const maxLoss = round(wings - credit);
          const delta = round(ps.delta + cs.delta);
          if (delta < this.filters.condorsMinDelta || delta > this.filters.condorsMaxDelta) continue;

          const pop = this._calcIronCondorPop(ps, cs, credit, exp);

          // IC has two BPE: lower = short put - credit, upper = short call + credit
          // Store lower BPE (downside break-even)
          const bpeLower = round(ps.stoOption.strikePrice - credit);
          const bpeUpper = round(cs.stoOption.strikePrice + credit);

          results.push({
            strategy_name: "Iron Condor",
            expiry_date: exp.expirationDate,
            dte: exp.daysToExpiration,
            legs: [
              this._leg("BTO", "Put", ps.btoOption),
              this._leg("STO", "Put", ps.stoOption),
              this._leg("STO", "Call", cs.stoOption),
              this._leg("BTO", "Call", cs.btoOption),
            ],
            credit,
            max_profit: credit,
            max_loss: maxLoss,
            // RR = maxLoss / credit (risk per $1 of max profit)
            rr_ratio: round(maxLoss / credit),
            pop,
            theta: round(ps.theta + cs.theta),
            delta,
            wings,
            // Store lower BPE; profit zone is bpeLower to bpeUpper
            bpe: bpeLower,
            price_effect: "Credit",
          });
        }
      }
    }
    return results;
  }

  private _buildIronButterflies(
    putSpreads: CreditSpread[],
    callSpreads: CreditSpread[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    const putByWings = groupBy(putSpreads, (s) => s.wingsWidth.toString());
    const callByWings = groupBy(callSpreads, (s) => s.wingsWidth.toString());

    for (const wing of Object.keys(putByWings)) {
      const pGroup = putByWings[wing];
      const cGroup = callByWings[wing];
      if (!cGroup) continue;
      for (const ps of pGroup) {
        for (const cs of cGroup) {
          // Iron Butterfly: STO put and STO call at SAME strike (ATM)
          if (ps.stoOption.strikePrice !== cs.stoOption.strikePrice) continue;

          const credit = round(ps.credit + cs.credit);
          const wings = ps.wingsWidth;
          const maxLoss = round(wings - credit);
          const pop = this._calcIronCondorPop(ps, cs, credit, exp);

          // IB BPE: lower = ATM strike - credit, upper = ATM strike + credit
          const bpeLower = round(ps.stoOption.strikePrice - credit);

          results.push({
            strategy_name: "Iron Butterfly",
            expiry_date: exp.expirationDate,
            dte: exp.daysToExpiration,
            legs: [
              this._leg("BTO", "Put", ps.btoOption),
              this._leg("STO", "Put", ps.stoOption),
              this._leg("STO", "Call", cs.stoOption),
              this._leg("BTO", "Call", cs.btoOption),
            ],
            credit,
            max_profit: credit,
            max_loss: maxLoss,
            rr_ratio: round(maxLoss / credit),
            pop,
            theta: round(ps.theta + cs.theta),
            delta: round(ps.delta + cs.delta),
            wings,
            bpe: bpeLower,
            price_effect: "Credit",
          });
        }
      }
    }
    return results;
  }

  private _buildJadeLizards(
    puts: OptionData[],
    callSpreads: CreditSpread[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const put of puts) {
      for (const cs of callSpreads) {
        const credit = round(put.midPrice + cs.credit);
        // Jade Lizard condition: credit >= wings → zero upside risk
        if (credit < cs.wingsWidth) continue;

        const maxRisk = round(put.strikePrice - credit);
        if (maxRisk <= 0) continue;

        // BPE for Jade Lizard = short put strike - total credit
        const bpe = round(put.strikePrice - credit);

        // Position greeks:
        //   STO put: negate put greeks (-1 × put.delta, -1 × put.theta)
        //   STO call (from spread): already negated in cs.stoOption via spread
        //   BTO call (from spread): already in cs.btoOption via spread
        // Since cs already has correct position greeks, we just negate the naked put
        // and add the spread's position greeks.
        //
        // Full calculation:
        //   delta = (-put.delta) + cs.delta  [cs.delta already has position signs]
        //   theta = (-put.theta) + cs.theta
        const positionDelta = round(-put.delta + cs.delta);
        const positionTheta = round(-put.theta + cs.theta);

        results.push({
          strategy_name: "Jade Lizard",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("STO", "Put", put),
            this._leg("STO", "Call", cs.stoOption),
            this._leg("BTO", "Call", cs.btoOption),
          ],
          credit,
          max_profit: credit,
          max_loss: maxRisk,
          rr_ratio: round(maxRisk / credit),
          pop: round(100 - put.absDelta * 100),
          theta: positionTheta,
          delta: positionDelta,
          wings: cs.wingsWidth,
          bpe,
          price_effect: "Credit",
        });
      }
    }
    return results;
  }

  private _buildTwistedSisters(
    calls: OptionData[],
    putSpreads: CreditSpread[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const call of calls) {
      for (const ps of putSpreads) {
        const credit = round(call.midPrice + ps.credit);
        // Twisted Sister condition: credit >= wings → zero downside risk
        if (credit < ps.wingsWidth) continue;

        // Max risk is on the upside (naked call) = theoretically unlimited,
        // but capped when credit >= wings. Max downside risk = 0.
        // For practical display: max loss on the put side = 0 (covered by credit).
        // The "max risk" here is a nominal value for comparison.
        const maxRisk = round(call.strikePrice - credit);
        if (maxRisk <= 0) continue;

        // BPE for Twisted Sister = short call strike + total credit (upside)
        // On downside, no risk since credit >= wings
        const bpe = round(call.strikePrice + credit);

        // Position greeks:
        //   BTO put (from spread): raw greeks (already in ps with position signs)
        //   STO put (from spread): already negated in ps
        //   STO call: negate call greeks
        const positionDelta = round(ps.delta + (-call.delta));
        const positionTheta = round(ps.theta + (-call.theta));

        results.push({
          strategy_name: "Twisted Sister",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("BTO", "Put", ps.btoOption),
            this._leg("STO", "Put", ps.stoOption),
            this._leg("STO", "Call", call),
          ],
          credit,
          max_profit: credit,
          max_loss: maxRisk,
          rr_ratio: round(maxRisk / credit),
          pop: round(100 - call.absDelta * 100),
          theta: positionTheta,
          delta: positionDelta,
          wings: ps.wingsWidth,
          bpe,
          price_effect: "Credit",
        });
      }
    }
    return results;
  }

  // =========================================================================
  // Debit strategy builders
  // =========================================================================

  private _buildLongStraddles(
    puts: OptionData[],
    calls: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const put of puts) {
      const call = calls.find((c) => c.strikePrice === put.strikePrice);
      if (!call) continue;
      if (!this._hasGoodBAS([put, call])) continue;

      const debit = round(put.midPrice + call.midPrice);
      if (debit <= 0) continue;

      // BPE for straddle: lower = strike - debit, upper = strike + debit
      const bpeLower = round(put.strikePrice - debit);

      // Position greeks: both legs are BTO (long), use raw greeks
      const positionTheta = round(put.theta + call.theta);
      const positionDelta = round(put.delta + call.delta);

      results.push({
        strategy_name: "Long Straddle",
        expiry_date: exp.expirationDate,
        dte: exp.daysToExpiration,
        legs: [
          this._leg("BTO", "Put", put),
          this._leg("BTO", "Call", call),
        ],
        credit: round(-debit),
        max_profit: -1, // unlimited
        max_loss: debit,
        rr_ratio: round(put.strikePrice / debit),
        pop: round((put.absDelta * 100 + call.absDelta * 100) / 2),
        theta: positionTheta,
        delta: positionDelta,
        wings: 0,
        bpe: bpeLower,
        price_effect: "Debit",
      });
    }
    return results;
  }

  private _buildLongStrangles(
    puts: OptionData[],
    calls: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const put of puts) {
      for (const call of calls) {
        if (put.strikePrice >= call.strikePrice) continue;
        if (!this._hasGoodBAS([put, call])) continue;

        const debit = round(put.midPrice + call.midPrice);
        if (debit <= 0) continue;

        const width = round(call.strikePrice - put.strikePrice);

        // BPE: lower = put strike - debit, upper = call strike + debit
        const bpeLower = round(put.strikePrice - debit);

        // Position greeks: both BTO, use raw greeks
        const positionTheta = round(put.theta + call.theta);
        const positionDelta = round(put.delta + call.delta);

        results.push({
          strategy_name: "Long Strangle",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("BTO", "Put", put),
            this._leg("BTO", "Call", call),
          ],
          credit: round(-debit),
          max_profit: -1, // unlimited
          max_loss: debit,
          rr_ratio: round(width / debit),
          pop: round((put.absDelta * 100 + call.absDelta * 100) / 2),
          theta: positionTheta,
          delta: positionDelta,
          wings: width,
          bpe: bpeLower,
          price_effect: "Debit",
        });
      }
    }
    return results;
  }

  private _buildBullCallSpreads(
    calls: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const btoCall of calls) {
      for (const wingWidth of this.filters.wings) {
        const stoStrike = exp.strikes.find(
          (s) => Math.abs(s.strikePrice - (btoCall.strikePrice + wingWidth)) < 0.01,
        );
        if (!stoStrike) continue;

        const stoCall = this._getOptionData(stoStrike, exp, "Call");
        if (!stoCall || stoCall.midPrice <= 0) continue;
        if (!this._hasGoodBAS([btoCall, stoCall])) continue;

        const debit = round(btoCall.midPrice - stoCall.midPrice);
        if (debit <= 0 || debit >= wingWidth) continue;

        const maxProfit = round(wingWidth - debit);

        // BPE for bull call spread = lower strike + debit
        const bpe = round(btoCall.strikePrice + debit);

        // Position greeks: BTO lower call + STO upper call
        // BTO: +btoCall.theta, STO: -stoCall.theta
        const positionTheta = round(btoCall.theta - stoCall.theta);
        const positionDelta = round(btoCall.delta - stoCall.delta);

        results.push({
          strategy_name: "Bull Call Spread",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("BTO", "Call", btoCall),
            this._leg("STO", "Call", stoCall),
          ],
          credit: round(-debit),
          max_profit: maxProfit,
          max_loss: debit,
          rr_ratio: round(debit / maxProfit),
          pop: round(100 - btoCall.absDelta * 100),
          theta: positionTheta,
          delta: positionDelta,
          wings: wingWidth,
          bpe,
          price_effect: "Debit",
        });
      }
    }
    return results;
  }

  private _buildBearPutSpreads(
    puts: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const btoPut of puts) {
      for (const wingWidth of this.filters.wings) {
        const stoStrike = exp.strikes.find(
          (s) => Math.abs(s.strikePrice - (btoPut.strikePrice - wingWidth)) < 0.01,
        );
        if (!stoStrike) continue;

        const stoPut = this._getOptionData(stoStrike, exp, "Put");
        if (!stoPut || stoPut.midPrice <= 0) continue;
        if (!this._hasGoodBAS([btoPut, stoPut])) continue;

        const debit = round(btoPut.midPrice - stoPut.midPrice);
        if (debit <= 0 || debit >= wingWidth) continue;

        const maxProfit = round(wingWidth - debit);

        // BPE for bear put spread = higher strike - debit
        const bpe = round(btoPut.strikePrice - debit);

        // Position greeks: BTO higher put + STO lower put
        const positionTheta = round(btoPut.theta - stoPut.theta);
        const positionDelta = round(btoPut.delta - stoPut.delta);

        results.push({
          strategy_name: "Bear Put Spread",
          expiry_date: exp.expirationDate,
          dte: exp.daysToExpiration,
          legs: [
            this._leg("BTO", "Put", btoPut),
            this._leg("STO", "Put", stoPut),
          ],
          credit: round(-debit),
          max_profit: maxProfit,
          max_loss: debit,
          rr_ratio: round(debit / maxProfit),
          pop: round(100 - btoPut.absDelta * 100),
          theta: positionTheta,
          delta: positionDelta,
          wings: wingWidth,
          bpe,
          price_effect: "Debit",
        });
      }
    }
    return results;
  }

  private _buildCallButterflies(
    calls: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const stoCall of calls) {
      for (const lowerWing of this.filters.wings) {
        const lowerStrike = exp.strikes.find(
          (s) => Math.abs(s.strikePrice - (stoCall.strikePrice - lowerWing)) < 0.01,
        );
        if (!lowerStrike) continue;
        const btoLower = this._getOptionData(lowerStrike, exp, "Call");
        if (!btoLower || btoLower.midPrice <= 0) continue;

        for (const upperWing of this.filters.wings) {
          const upperStrike = exp.strikes.find(
            (s) => Math.abs(s.strikePrice - (stoCall.strikePrice + upperWing)) < 0.01,
          );
          if (!upperStrike) continue;
          const btoUpper = this._getOptionData(upperStrike, exp, "Call");
          if (!btoUpper || btoUpper.midPrice <= 0) continue;
          if (!this._hasGoodBAS([btoLower, stoCall, btoUpper])) continue;

          // Debit = BTO lower + BTO upper - 2×STO mid
          const debit = round(btoLower.midPrice - 2 * stoCall.midPrice + btoUpper.midPrice);
          const isCredit = debit < 0;
          if (debit <= 0 && !isCredit) continue;

          const maxProfit = round(lowerWing - debit);
          const name = lowerWing !== upperWing ? "Broken Wing Call Butterfly" : "Call Butterfly";

          // BPE: lower = lower strike + debit, upper = upper strike - debit
          const bpe = round(btoLower.strikePrice + Math.abs(debit));

          // Position greeks: BTO lower + 2×STO mid + BTO upper
          const positionTheta = round(btoLower.theta - 2 * stoCall.theta + btoUpper.theta);
          const positionDelta = round(btoLower.delta - 2 * stoCall.delta + btoUpper.delta);

          results.push({
            strategy_name: name,
            expiry_date: exp.expirationDate,
            dte: exp.daysToExpiration,
            legs: [
              this._leg("BTO", "Call", btoLower),
              { action: "STO", type: "Call", strike: stoCall.strikePrice, price: stoCall.midPrice, delta: round(stoCall.delta), spread: stoCall.bidAskSpread, quantity: 2 },
              this._leg("BTO", "Call", btoUpper),
            ],
            credit: round(-debit),
            max_profit: maxProfit,
            max_loss: isCredit ? 0 : debit,
            rr_ratio: maxProfit > 0 ? round(Math.abs(debit) / maxProfit) : 0,
            pop: round(100 - stoCall.absDelta * 100),
            theta: positionTheta,
            delta: positionDelta,
            wings: lowerWing,
            bpe,
            price_effect: isCredit ? "Credit" : "Debit",
          });
        }
      }
    }
    return results;
  }

  private _buildPutButterflies(
    puts: OptionData[],
    exp: ParsedExpiration,
  ): StrategySetup[] {
    const results: StrategySetup[] = [];
    for (const stoPut of puts) {
      for (const lowerWing of this.filters.wings) {
        const lowerStrike = exp.strikes.find(
          (s) => Math.abs(s.strikePrice - (stoPut.strikePrice - lowerWing)) < 0.01,
        );
        if (!lowerStrike) continue;
        const btoLower = this._getOptionData(lowerStrike, exp, "Put");
        if (!btoLower || btoLower.midPrice <= 0) continue;

        for (const upperWing of this.filters.wings) {
          const upperStrike = exp.strikes.find(
            (s) => Math.abs(s.strikePrice - (stoPut.strikePrice + upperWing)) < 0.01,
          );
          if (!upperStrike) continue;
          const btoUpper = this._getOptionData(upperStrike, exp, "Put");
          if (!btoUpper || btoUpper.midPrice <= 0) continue;
          if (!this._hasGoodBAS([btoLower, stoPut, btoUpper])) continue;

          const debit = round(btoLower.midPrice - 2 * stoPut.midPrice + btoUpper.midPrice);
          const isCredit = debit < 0;
          if (debit <= 0 && !isCredit) continue;

          const maxProfit = round(lowerWing - debit);
          const name = lowerWing !== upperWing ? "Broken Wing Put Butterfly" : "Put Butterfly";

          // BPE: lower = lower strike + debit
          const bpe = round(btoLower.strikePrice + Math.abs(debit));

          // Position greeks: BTO lower + 2×STO mid + BTO upper
          const positionTheta = round(btoLower.theta - 2 * stoPut.theta + btoUpper.theta);
          const positionDelta = round(btoLower.delta - 2 * stoPut.delta + btoUpper.delta);

          results.push({
            strategy_name: name,
            expiry_date: exp.expirationDate,
            dte: exp.daysToExpiration,
            legs: [
              this._leg("BTO", "Put", btoLower),
              { action: "STO", type: "Put", strike: stoPut.strikePrice, price: stoPut.midPrice, delta: round(stoPut.delta), spread: stoPut.bidAskSpread, quantity: 2 },
              this._leg("BTO", "Put", btoUpper),
            ],
            credit: round(-debit),
            max_profit: maxProfit,
            max_loss: isCredit ? 0 : debit,
            rr_ratio: maxProfit > 0 ? round(Math.abs(debit) / maxProfit) : 0,
            pop: round(100 - stoPut.absDelta * 100),
            theta: positionTheta,
            delta: positionDelta,
            wings: lowerWing,
            bpe,
            price_effect: isCredit ? "Credit" : "Debit",
          });
        }
      }
    }
    return results;
  }

  // =========================================================================
  // Infrastructure — parsing, filtering, spreads
  // =========================================================================

  private _parseChain(rawChain: any): ParsedExpiration[] {
    // SDK returns an ARRAY of chain objects, each with .expirations
    // (see main app: tasty-market-data-provider.ts → getOptionsChain)
    const chainArray: any[] = Array.isArray(rawChain) ? rawChain : [rawChain];

    const allExpirations: ParsedExpiration[] = [];

    for (const chain of chainArray) {
      const expirations: any[] = chain?.expirations ?? chain?.data?.items ?? [];
      if (!Array.isArray(expirations)) continue;

      for (const exp of expirations) {
        const rawStrikes = exp?.strikes ?? exp?.["strikes"] ?? [];
        if (!Array.isArray(rawStrikes) || rawStrikes.length === 0) continue;

        const strikes = rawStrikes.map((s: any) => ({
          strikePrice: parseFloat(s["strike-price"] ?? s.strikePrice ?? "0"),
          callSymbol: s.call ?? s.callId ?? "",
          putSymbol: s.put ?? s.putId ?? "",
          callStreamer: s["call-streamer-symbol"] ?? s.callStreamerSymbol ?? s.call ?? "",
          putStreamer: s["put-streamer-symbol"] ?? s.putStreamerSymbol ?? s.put ?? "",
        }));

        allExpirations.push({
          expirationDate: exp["expiration-date"] ?? exp.expirationDate ?? "",
          daysToExpiration: exp["days-to-expiration"] ?? exp.daysToExpiration ?? 0,
          expirationType: exp["expiration-type"] ?? exp.expirationType ?? "",
          strikes,
        });
      }
    }

    logger.debug(
      `[StrategyBuilder] Parsed ${allExpirations.length} expirations from ${chainArray.length} chain(s)`,
    );

    return allExpirations;
  }

  private _buildOptionDataList(exp: ParsedExpiration, type: "Put" | "Call"): OptionData[] {
    const results: OptionData[] = [];
    for (const strike of exp.strikes) {
      const streamerSym = type === "Put" ? strike.putStreamer : strike.callStreamer;
      const symbol = type === "Put" ? strike.putSymbol : strike.callSymbol;
      const quote = this.tastyClient.getQuote(streamerSym);
      const greeks = this.tastyClient.getGreeks(streamerSym);
      const bidPrice = quote?.bidPrice ?? 0;
      const askPrice = quote?.askPrice ?? 0;
      results.push({
        symbol,
        streamerSymbol: streamerSym,
        strikePrice: strike.strikePrice,
        type,
        expirationDate: exp.expirationDate,
        dte: exp.daysToExpiration,
        bidPrice,
        askPrice,
        midPrice: round((bidPrice + askPrice) / 2),
        delta: greeks?.delta ?? 0,
        absDelta: Math.abs(greeks?.delta ?? 0),
        theta: greeks?.theta ?? 0,
        bidAskSpread: round(askPrice - bidPrice),
      });
    }
    return results.sort((a, b) => b.absDelta - a.absDelta);
  }


  private _getOptionData(
    strike: ParsedStrike,
    exp: ParsedExpiration,
    type: "Put" | "Call",
  ): OptionData | null {
    const streamerSym = type === "Put" ? strike.putStreamer : strike.callStreamer;
    const symbol = type === "Put" ? strike.putSymbol : strike.callSymbol;
    const quote = this.tastyClient.getQuote(streamerSym);
    const greeks = this.tastyClient.getGreeks(streamerSym);
    const bid = quote?.bidPrice ?? 0;
    const ask = quote?.askPrice ?? 0;
    const mid = round((bid + ask) / 2);
    if (mid <= 0) return null;
    return {
      symbol,
      streamerSymbol: streamerSym,
      strikePrice: strike.strikePrice,
      type,
      expirationDate: exp.expirationDate,
      dte: exp.daysToExpiration,
      bidPrice: bid,
      askPrice: ask,
      midPrice: mid,
      delta: greeks?.delta ?? 0,
      absDelta: Math.abs(greeks?.delta ?? 0),
      theta: greeks?.theta ?? 0,
      bidAskSpread: round(ask - bid),
    };
  }

  private _filterByDelta(options: OptionData[], minD: number, maxD: number): OptionData[] {
    return options.filter((o) => o.absDelta >= minD && o.absDelta <= maxD && o.midPrice > 0);
  }

  /**
   * Build credit spreads with CORRECT position greeks.
   *
   * For a credit spread:
   *   STO leg (short): negate raw greeks → -stoOption.delta, -stoOption.theta
   *   BTO leg (long):  use raw greeks  → +btoOption.delta, +btoOption.theta
   *
   * Result for put credit spread:
   *   delta = -stoOption.delta + btoOption.delta  (should be positive/bullish)
   *   theta = -stoOption.theta + btoOption.theta  (should be positive — time helps)
   */
  private _buildCreditSpreads(
    options: OptionData[],
    allStrikes: ParsedStrike[],
    type: "put" | "call",
  ): CreditSpread[] {
    const spreads: CreditSpread[] = [];
    const wingSign = type === "put" ? -1 : 1;

    for (const stoOption of options) {
      if (stoOption.midPrice <= 0) continue;
      for (const wingWidth of this.filters.wings) {
        const targetStrike = round(stoOption.strikePrice + wingSign * wingWidth, 4);
        const btoStrike = allStrikes.find((s) => Math.abs(s.strikePrice - targetStrike) < 0.01);
        if (!btoStrike) continue;

        const btoStreamer = type === "put" ? btoStrike.putStreamer : btoStrike.callStreamer;
        const btoSymbol = type === "put" ? btoStrike.putSymbol : btoStrike.callSymbol;
        const btoQuote = this.tastyClient.getQuote(btoStreamer);
        const btoGreeks = this.tastyClient.getGreeks(btoStreamer);
        const btoBid = btoQuote?.bidPrice ?? 0;
        const btoAsk = btoQuote?.askPrice ?? 0;
        const btoMid = round((btoBid + btoAsk) / 2);
        if (btoMid <= 0) continue;

        const stoBAS = stoOption.bidAskSpread;
        const btoBAS = round(btoAsk - btoBid);
        if (stoBAS > this.filters.maxBidAskSpread || btoBAS > this.filters.maxBidAskSpread) continue;
        if (stoBAS < 0 || btoBAS < 0) continue;

        const btoOption: OptionData = {
          symbol: btoSymbol,
          streamerSymbol: btoStreamer,
          strikePrice: btoStrike.strikePrice,
          type: type === "put" ? "Put" : "Call",
          expirationDate: stoOption.expirationDate,
          dte: stoOption.dte,
          bidPrice: btoBid,
          askPrice: btoAsk,
          midPrice: btoMid,
          delta: btoGreeks?.delta ?? 0,
          absDelta: Math.abs(btoGreeks?.delta ?? 0),
          theta: btoGreeks?.theta ?? 0,
          bidAskSpread: btoBAS,
        };

        const credit = round(stoOption.midPrice - btoMid);
        if (credit <= 0) continue;

        const maxLoss = round(wingWidth - credit);

        spreads.push({
          stoOption,
          btoOption,
          wingsWidth: wingWidth,
          credit,
          // RR = maxLoss / credit (risk per $1 of max profit)
          riskRewardRatio: round(maxLoss / credit),
          // Position greeks: STO negated + BTO raw
          delta: round(-stoOption.delta + btoOption.delta),
          theta: round(-stoOption.theta + btoOption.theta),
          type,
        });
      }
    }
    return spreads;
  }

  private _calcIronCondorPop(
    ps: CreditSpread,
    cs: CreditSpread,
    totalCredit: number,
    exp: ParsedExpiration,
  ): number {
    const putBE = ps.stoOption.strikePrice - totalCredit;
    const callBE = cs.stoOption.strikePrice + totalCredit;
    const putBEDelta = this._findDeltaAtStrike(exp, putBE, "put");
    const callBEDelta = this._findDeltaAtStrike(exp, callBE, "call");
    return round((1 - (Math.abs(putBEDelta) + Math.abs(callBEDelta))) * 100);
  }

  private _findDeltaAtStrike(exp: ParsedExpiration, target: number, type: "put" | "call"): number {
    let closest: ParsedStrike | null = null;
    let minDiff = Infinity;
    for (const strike of exp.strikes) {
      const diff = type === "put" ? target - strike.strikePrice : strike.strikePrice - target;
      if (diff >= 0 && diff < minDiff) { minDiff = diff; closest = strike; }
    }
    if (!closest) return 0;
    const streamer = type === "put" ? closest.putStreamer : closest.callStreamer;
    return this.tastyClient.getGreeks(streamer)?.delta ?? 0;
  }

  private _hasGoodBAS(options: OptionData[]): boolean {
    return !options.some((o) => o.bidAskSpread < 0 || o.bidAskSpread > this.filters.maxBidAskSpread);
  }

  private _leg(action: "BTO" | "STO", type: "Put" | "Call", opt: OptionData): StrategyLeg {
    return {
      action,
      type,
      strike: opt.strikePrice,
      price: opt.midPrice,
      delta: round(opt.delta),
      spread: opt.bidAskSpread,
    };
  }

  private async _waitForData(sampleSymbols: string[], maxWaitMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (sampleSymbols.some((sym) => this.tastyClient.getQuote(sym) !== undefined)) {
        logger.debug("[StrategyBuilder] Streamer data arrived");
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    logger.warn("[StrategyBuilder] Timed out waiting for streamer data");
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function round(value: number, decimals = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = keyFn(item);
    (result[key] ??= []).push(item);
  }
  return result;
}

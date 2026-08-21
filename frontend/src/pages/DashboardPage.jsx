import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Pie,
  PieChart,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts'

import {
  ChartContainer,
  ChartTooltip,
} from '@/components/ui/chart'
import { Button } from '@/components/ui/button'
import { getRequest } from '@/services/api'


// --- Constants ---

const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const chartColors = [
  '#1e3a8a',
  '#2563eb',
  '#3b82f6',
  '#60a5fa',
  '#93c5fd',
  '#bfdbfe',
]


// --- Formatting Helpers ---

function formatMoney(value) {
  return Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}


function formatQuantity(value) {
  return Number(value ?? 0).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })
}


function parseDateParts(dateString) {
  const [year, month, day] = dateString.split('-').map(Number)

  return {
    year,
    monthIndex: month - 1,
    day,
  }
}


function formatDate(dateString) {
  return new Date(`${dateString}T00:00:00`).toLocaleDateString()
}


// --- Data Helpers ---

// The API returns account -> symbol -> stats. The table and donut are easier
// to work with once that nested object is flattened into normal rows.
function flattenCostBasis(response) {
  return Object.entries(response ?? {}).flatMap(
    ([account, symbols]) =>
      Object.entries(symbols ?? {}).map(([symbol, stats]) => ({
        account,
        symbol,
        ...stats,
        status:
          Number(stats.remaining_quantity) > 1e-9
            ? 'Open'
            : 'Closed',
      }))
  )
}


// Keep the backend vocabulary intact, then add the small display labels the
// chart needs. The original transaction type/subtype stay on every row.
function normalizeActivity(response) {
  return (response ?? []).map((item) => {
    const amount = Number(item.amount ?? 0)
    let type = item.transaction_subtype

    // Fidelity transfer rows do not always say deposit/withdrawal explicitly,
    // so the sign of the amount tells us which direction the cash moved.
    if (item.transaction_type === 'transfer') {
      type = amount >= 0 ? 'deposit' : 'withdraw'
    } else if (item.transaction_subtype === 'bought') {
      type = 'buy'
    } else if (item.transaction_subtype === 'sold') {
      type = 'sell'
    } else if (item.transaction_subtype === 'reinvestment') {
      type = 'reinvest'
    }

    return {
      date: item.run_date,
      account: item.account_number,
      symbol: item.symbol,
      amount: Math.abs(amount),
      type,
      transactionType: item.transaction_type,
      transactionSubtype: item.transaction_subtype,
      month: item.month,
    }
  })
}


// Dividend data is returned per symbol, while the heatmap needs one total
// for each month across the selected account/symbol set.
function summarizeDividends(response) {
  const monthlyDividend = Object.fromEntries(
    months.map((month) => [month, 0])
  )

  let totalDividend = 0
  let totalLongTermCapGain = 0

  for (const symbols of Object.values(response ?? {})) {
    for (const stats of Object.values(symbols ?? {})) {
      totalDividend += Number(stats.total_dividend ?? 0)
      totalLongTermCapGain += Number(
        stats.total_long_term_cap_gain ?? 0
      )

      for (const month of months) {
        monthlyDividend[month] += Number(
          stats.monthly_dividend?.[month] ?? 0
        )
      }
    }
  }

  return {
    totalDividend,
    totalLongTermCapGain,
    monthlyDividend,
  }
}


// --- Shared Components ---

function StatCard({ title, value, description }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-xs text-muted-foreground">
        {title}
      </p>

      <p className="mt-1 truncate text-xl font-semibold">
        {value}
      </p>

      <p className="mt-1 truncate text-xs text-muted-foreground">
        {description}
      </p>
    </div>
  )
}


function SortableHeader({
  label,
  sortKey,
  sortConfig,
  onSort,
  align = 'right',
}) {
  const active = sortConfig.key === sortKey
  const indicator = active
    ? sortConfig.direction === 'asc'
      ? '↑'
      : '↓'
    : '↕'

  return (
    <th
      className={`px-4 py-2 font-medium ${
        align === 'left' ? 'text-left' : 'text-right'
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex w-full items-center gap-1 hover:text-foreground ${
          align === 'left' ? 'justify-start' : 'justify-end'
        }`}
      >
        <span>{label}</span>

        <span
          className={
            active
              ? 'text-foreground'
              : 'text-muted-foreground/60'
          }
        >
          {indicator}
        </span>
      </button>
    </th>
  )
}


// --- Account Activity ---

function AccountActivity({
  accountActivity,
  year,
  transactionType,
}) {
  const yearActivity = accountActivity.filter(
    (item) => parseDateParts(item.date).year === year
  )

  const monthTicks = months.map(
    (_, monthIndex) => monthIndex + 0.5
  )

  // Account Activity has two views on purpose. Mixing cash-flow bars and
  // trade markers made both harder to read, especially when one side had
  // much larger dollar values than the other.
  const activityMode =
    transactionType === 'transfer'
      ? 'transfer'
      : transactionType === 'trade'
        ? 'trade'
        : 'select'

  const transferData = months.map((month, monthIndex) => {
    const monthActivity = yearActivity.filter(
      (item) => parseDateParts(item.date).monthIndex === monthIndex
    )

    const deposit = monthActivity
      .filter((item) => item.type === 'deposit')
      .reduce((total, item) => total + item.amount, 0)

    const withdrawal = monthActivity
      .filter((item) => item.type === 'withdraw')
      .reduce((total, item) => total - item.amount, 0)

    return {
      x: monthIndex + 0.5,
      month,
      deposit,
      withdrawal,
    }
  })

  const tradeActivity = yearActivity.filter(
    (item) => ['buy', 'sell', 'reinvest'].includes(item.type)
  )

  // Use the transaction amount as the y-position instead of putting each
  // action on a fixed row. This gives dense months much more room.
  const tradePoints = tradeActivity.map((item, index) => {
    const date = parseDateParts(item.date)
    const daysInMonth = new Date(
      date.year,
      date.monthIndex + 1,
      0
    ).getDate()

    const sameDateIndex = tradeActivity
      .slice(0, index)
      .filter((previous) => previous.date === item.date)
      .length

    return {
      ...item,
      x:
        date.monthIndex +
        (date.day - 0.5) / daysInMonth +
        sameDateIndex * 0.012,
      y: item.amount,
    }
  })

  const chartConfig = {
    deposit: {
      label: 'Deposit',
      color: '#1d4ed8',
    },
    withdrawal: {
      label: 'Withdrawal',
      color: '#93c5fd',
    },
    trade: {
      label: 'Trade',
      color: '#18181b',
    },
  }

  function TransferTooltip({ active, payload }) {
    if (!active || !payload?.length) {
      return null
    }

    const visibleEntries = payload.filter(
      (entry) =>
        (entry.dataKey === 'deposit' ||
          entry.dataKey === 'withdrawal') &&
        Number(entry.value) !== 0
    )

    if (visibleEntries.length === 0) {
      return null
    }

    const monthLabel =
      visibleEntries[0]?.payload?.month ?? ''

    return (
      <div className="min-w-40 rounded-lg border bg-background px-3 py-2 text-xs shadow-lg">
        <p className="font-semibold text-foreground">
          {monthLabel}
        </p>

        <div className="mt-1 space-y-1">
          {visibleEntries.map((entry) => (
            <div
              key={entry.dataKey}
              className="flex justify-between gap-4"
            >
              <span className="text-muted-foreground">
                {entry.dataKey === 'deposit'
                  ? 'Deposit'
                  : 'Withdrawal'}
              </span>

              <span className="font-medium text-foreground">
                {Number(entry.value) >= 0 ? '+' : '-'}$
                {formatMoney(Math.abs(Number(entry.value)))}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  function TradeTooltip({ active, payload }) {
    if (!active || !payload?.length) {
      return null
    }

    const transaction = payload.find(
      (entry) =>
        entry?.payload?.date &&
        ['buy', 'sell', 'reinvest'].includes(
          entry?.payload?.type
        )
    )?.payload

    if (!transaction) {
      return null
    }

    const action =
      transaction.type === 'reinvest'
        ? 'Reinvest'
        : transaction.type.charAt(0).toUpperCase() +
          transaction.type.slice(1)

    return (
      <div className="min-w-44 rounded-lg border bg-background px-3 py-2 text-xs shadow-lg">
        <p className="font-semibold text-foreground">
          {transaction.symbol ?? 'Cash'}
        </p>

        <div className="mt-1 space-y-1 text-muted-foreground">
          <div className="flex justify-between gap-4">
            <span>Action</span>
            <span className="font-medium text-foreground">
              {action}
            </span>
          </div>

          <div className="flex justify-between gap-4">
            <span>Date</span>
            <span className="font-medium text-foreground">
              {formatDate(transaction.date)}
            </span>
          </div>

          <div className="flex justify-between gap-4">
            <span>Amount</span>
            <span className="font-medium text-foreground">
              ${formatMoney(transaction.amount)}
            </span>
          </div>
        </div>
      </div>
    )
  }

  function TradePoint({ cx, cy, payload }) {
    if (
      !Number.isFinite(cx) ||
      !Number.isFinite(cy) ||
      !payload
    ) {
      return null
    }

    // Slightly oversized markers are intentional; they are much easier to
    // hover than Recharts' small default scatter points.
    if (payload.type === 'sell') {
      return (
        <circle
          cx={cx}
          cy={cy}
          r={6}
          fill="#ffffff"
          stroke="#71717a"
          strokeWidth={2}
        />
      )
    }

    if (payload.type === 'reinvest') {
      return (
        <rect
          x={cx - 5}
          y={cy - 5}
          width={10}
          height={10}
          rx={1}
          fill="#3b82f6"
          transform={`rotate(45 ${cx} ${cy})`}
        />
      )
    }

    return (
      <circle
        cx={cx}
        cy={cy}
        r={6}
        fill="#18181b"
      />
    )
  }

  const subtitle =
    activityMode === 'transfer'
      ? `Monthly cash movement · ${year}`
      : activityMode === 'trade'
        ? `Buy, sell, and reinvestment activity · ${year}`
        : `Choose Trade or Transfer · ${year}`

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">
              Account Activity
            </h2>

            <span
              title="Trade shows buy, sell, and reinvestment points. Transfer shows monthly deposits and withdrawals."
              className="cursor-help text-[11px] text-muted-foreground"
            >
              ?
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            {subtitle}
          </p>
        </div>

        {activityMode === 'trade' && (
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-zinc-900" />
              Buy
            </span>

            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full border border-zinc-500 bg-white" />
              Sell
            </span>

            <span className="flex items-center gap-1">
              <span className="size-2 rotate-45 bg-blue-500" />
              Reinvest
            </span>
          </div>
        )}

        {activityMode === 'transfer' && (
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-blue-700" />
              Deposit
            </span>

            <span className="flex items-center gap-1">
              <span className="size-2 rounded-sm bg-blue-300" />
              Withdraw
            </span>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 p-2">
        {activityMode === 'select' ? (
          <div className="flex h-full min-h-[150px] items-center justify-center rounded-lg border border-dashed bg-muted/20 px-8 text-center">
            <div>
              <p className="text-sm font-medium">
                Choose an activity view
              </p>

              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                Select Trade to inspect buy, sell, and reinvestment
                transactions, or Transfer to view deposits and withdrawals.
              </p>
            </div>
          </div>
        ) : activityMode === 'transfer' ? (
          <ChartContainer
            config={chartConfig}
            className="h-full min-h-[150px] w-full"
          >
            <ComposedChart
              accessibilityLayer
              data={transferData}
              margin={{
                top: 8,
                right: 10,
                bottom: 4,
                left: 10,
              }}
            >
              <CartesianGrid
                vertical={false}
                strokeDasharray="3 3"
              />

              <XAxis
                type="number"
                dataKey="x"
                domain={[0, 12]}
                ticks={monthTicks}
                tickFormatter={(value) =>
                  months[Math.min(11, Math.floor(value))]
                }
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={10}
              />

              <YAxis hide />

              <ChartTooltip
                content={<TransferTooltip />}
              />

              <ReferenceLine
                y={0}
                stroke="#d4d4d8"
                strokeWidth={1}
              />

              <Bar
                dataKey="deposit"
                fill="var(--color-deposit)"
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
              />

              <Bar
                dataKey="withdrawal"
                fill="var(--color-withdrawal)"
                radius={[0, 0, 4, 4]}
                maxBarSize={28}
              />
            </ComposedChart>
          </ChartContainer>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="h-full min-h-[150px] w-full"
          >
            <ScatterChart
              accessibilityLayer
              margin={{
                top: 12,
                right: 14,
                bottom: 4,
                left: 10,
              }}
            >
              <CartesianGrid
                vertical={false}
                strokeDasharray="3 3"
              />

              <XAxis
                type="number"
                dataKey="x"
                domain={[0, 12]}
                ticks={monthTicks}
                tickFormatter={(value) =>
                  months[Math.min(11, Math.floor(value))]
                }
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={10}
              />

              <YAxis
                type="number"
                dataKey="y"
                hide
                domain={[0, 'auto']}
              />

              <ChartTooltip
                cursor={{
                  stroke: '#d4d4d8',
                  strokeDasharray: '3 3',
                }}
                content={<TradeTooltip />}
              />

              <Scatter
                name="Trade activity"
                data={tradePoints}
                shape={<TradePoint />}
              />
            </ScatterChart>
          </ChartContainer>
        )}
      </div>
    </section>
  )
}


// --- Portfolio Allocation ---

function AllocationDonut({ positions }) {
  const [activeSegment, setActiveSegment] = useState(null)

  const segments = positions
    .filter(
      (position) =>
        position.status === 'Open' &&
        Number(position.remaining_cost_basis) > 0
    )
    .map((position, index) => ({
      symbol: position.symbol,
      value: Number(position.remaining_cost_basis),
      color: chartColors[index % chartColors.length],
    }))

  const totalValue = segments.reduce(
    (total, position) => total + position.value,
    0
  )

  const activePercent =
    activeSegment && totalValue > 0
      ? (activeSegment.value / totalValue) * 100
      : 0

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="shrink-0 border-b px-4 py-3">
        <h2 className="font-semibold">
          Portfolio Allocation
        </h2>

        <p className="text-xs text-muted-foreground">
          Allocation by remaining cost basis
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3">
        <div className="relative min-h-0 w-full flex-1">
          {segments.length > 0 ? (
            <ChartContainer
              config={{
                value: {
                  label: 'Cost Basis',
                },
              }}
              className="h-full min-h-[120px] w-full"
            >
              <PieChart>
                <Pie
                  data={segments}
                  dataKey="value"
                  nameKey="symbol"
                  innerRadius="58%"
                  outerRadius="82%"
                  paddingAngle={1}
                  strokeWidth={0}
                >
                  {segments.map((segment) => (
                    <Cell
                      key={segment.symbol}
                      fill={segment.color}
                      onMouseEnter={() =>
                        setActiveSegment(segment)
                      }
                      onMouseLeave={() =>
                        setActiveSegment(null)
                      }
                    />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
          ) : (
            <div className="mx-auto aspect-square h-full max-h-40 rounded-full border bg-muted" />
          )}

          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] text-muted-foreground">
              Cost Basis
            </span>

            <span className="text-sm font-semibold">
              ${totalValue.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            </span>
          </div>
        </div>

        {/* Keep hover details outside the pie so the popup never covers a slice. */}
        <div className="flex h-12 w-full shrink-0 items-center rounded-lg border bg-muted/20 px-3 py-2 text-xs">
          {activeSegment ? (
            <div className="flex w-full items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: activeSegment.color,
                  }}
                />

                <span className="truncate font-semibold">
                  {activeSegment.symbol}
                </span>
              </div>

              <div className="text-right">
                <p className="font-medium">
                  ${formatMoney(activeSegment.value)}
                </p>

                <p className="text-[10px] text-muted-foreground">
                  {activePercent.toFixed(1)}%
                </p>
              </div>
            </div>
          ) : (
            <p className="w-full text-center text-muted-foreground">
              Hover a slice for allocation details.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}


// --- Dividend Activity ---

function DividendHeatmap({ monthlyDividend, totalDividends, year }) {
  const values = months.map(
    (month) => Number(monthlyDividend?.[month] ?? 0)
  )

  const maxDividend = Math.max(...values, 1)

  function heatmapColor(amount) {
    if (amount === 0) {
      return '#eff6ff'
    }

    const ratio = amount / maxDividend

    if (ratio < 0.25) {
      return '#dbeafe'
    }

    if (ratio < 0.5) {
      return '#93c5fd'
    }

    if (ratio < 0.75) {
      return '#60a5fa'
    }

    return '#2563eb'
  }

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="font-semibold">
            Dividend Activity
          </h2>

          <p className="text-xs text-muted-foreground">
            Distribution intensity · {year}
          </p>
        </div>

        <div className="text-right">
          <p className="text-xs text-muted-foreground">
            Total
          </p>

          <p className="text-sm font-semibold">
            ${formatMoney(totalDividends)}
          </p>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-4 gap-2 p-4">
        {months.map((month, index) => {
          const amount = values[index]
          const background = heatmapColor(amount)
          const darkCell = amount / maxDividend > 0.55

          return (
            <div
              key={month}
              title={`${month}: $${formatMoney(amount)}`}
              className="flex min-h-0 flex-col items-center justify-center rounded-md border border-blue-100"
              style={{
                backgroundColor: background,
                color: darkCell ? 'white' : '#1e3a8a',
              }}
            >
              <span className="text-xs font-medium">
                {month}
              </span>

              <span className="mt-1 text-[10px]">
                ${amount.toFixed(0)}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}


// --- Dashboard ---

function DashboardPage() {
  // --- Filter State ---

  const [filterOptions, setFilterOptions] = useState({
    account: [],
    year: [],
    symbol: [],
    transaction_type: [],
    transaction_subtype: [],
    status: ['open', 'closed'],
  })

  const [accountFilter, setAccountFilter] = useState('')
  const [yearFilter, setYearFilter] = useState(null)
  const [symbolFilter, setSymbolFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [transactionTypeFilter, setTransactionTypeFilter] =
    useState('')
  const [transactionSubtypeFilter, setTransactionSubtypeFilter] =
    useState('')

  // --- API State ---

  const [costBasisResponse, setCostBasisResponse] = useState({})
  const [positionResponse, setPositionResponse] = useState({})
  const [dividendResponse, setDividendResponse] = useState({})
  const [activityResponse, setActivityResponse] = useState([])
  const [principalResponse, setPrincipalResponse] = useState({
    total_principal: 0,
  })

  // --- Table State ---

  // Sorting stays in the browser because Position History is already a small,
  // fully aggregated table by the time it reaches this page.
  const [sortConfig, setSortConfig] = useState({
    key: 'symbol',
    direction: 'asc',
  })

  // --- UI State ---

  const [loadingFilters, setLoadingFilters] = useState(true)
  const [loadingDashboard, setLoadingDashboard] = useState(false)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)


  // --- Load Filter Options ---

  // Filter choices only change when the backend dataset changes, so load
  // them once when the dashboard mounts.
  useEffect(() => {
    let cancelled = false

    async function loadFilters() {
      try {
        setLoadingFilters(true)
        setError('')

        const options = await getRequest('/filters')

        if (cancelled) {
          return
        }

        setFilterOptions(options)
        setAccountFilter(options.account?.[0] ?? '')
        setYearFilter(options.year?.[0] ?? null)

        // Trade is the most useful default for Account Activity. Transfer can
        // be selected when the user wants to inspect cash movement instead.
        setTransactionTypeFilter(
          options.transaction_type?.includes('trade')
            ? 'trade'
            : options.transaction_type?.[0] ?? ''
        )
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.message)
        }
      } finally {
        if (!cancelled) {
          setLoadingFilters(false)
        }
      }
    }

    loadFilters()

    return () => {
      cancelled = true
    }
  }, [])


  // --- Load Dashboard Data ---

  // The visible dashboard data follows the current filter state. Each route
  // still decides which filters actually make sense for its calculation.
  useEffect(() => {
    if (!accountFilter || yearFilter === null) {
      return
    }

    let cancelled = false

    async function loadDashboard() {
      try {
        setLoadingDashboard(true)
        setError('')

        // Position History is all-time. Year and activity filters are kept out
        // of the cost-basis request so old purchases are never discarded.
        const activityParams = {
          account: accountFilter,
          year: yearFilter,
          transaction_subtype: transactionSubtypeFilter,
        }

        // Transfers do not have symbols, so a symbol filter would otherwise
        // hide every deposit/withdrawal. Trade mode also leaves the raw type
        // open because reinvestments can be classified differently by Fidelity.
        if (transactionTypeFilter !== 'transfer') {
          activityParams.symbol = symbolFilter
        }

        if (
          transactionTypeFilter &&
          transactionTypeFilter !== 'trade'
        ) {
          activityParams.transaction_type =
            transactionTypeFilter
        }

        const [
          costBasis,
          positions,
          dividends,
          activity,
        ] = await Promise.all([
          getRequest('/cost_basis', {
            account: accountFilter,
            symbol: symbolFilter,
          }),
          getRequest('/cost_basis', {
            account: accountFilter,
            symbol: symbolFilter,
            status: statusFilter,
          }),
          getRequest('/dividend', {
            account: accountFilter,
            year: yearFilter,
            symbol: symbolFilter,
          }),
          getRequest('/activity', activityParams),
        ])

        if (cancelled) {
          return
        }

        setCostBasisResponse(costBasis)
        setPositionResponse(positions)
        setDividendResponse(dividends)
        setActivityResponse(activity)
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.message)
        }
      } finally {
        if (!cancelled) {
          setLoadingDashboard(false)
        }
      }
    }

    loadDashboard()

    return () => {
      cancelled = true
    }
  }, [
    accountFilter,
    yearFilter,
    symbolFilter,
    statusFilter,
    transactionTypeFilter,
    transactionSubtypeFilter,
    refreshKey,
  ])


  // --- Load Principal ---

  // Principal is all-time and account-level, so it has its own request.
  // The backend excludes transfers between Fidelity accounts before summing.
  useEffect(() => {
    if (!accountFilter) {
      return
    }

    let cancelled = false

    async function loadPrincipal() {
      try {
        const principal = await getRequest('/principal', {
          account: accountFilter,
        })

        if (!cancelled) {
          setPrincipalResponse(principal)
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.message)
        }
      }
    }

    loadPrincipal()

    return () => {
      cancelled = true
    }
  }, [accountFilter, refreshKey])


  // --- Derived Data ---

  const accountPositions = useMemo(
    () => flattenCostBasis(costBasisResponse),
    [costBasisResponse]
  )

  const positionHistory = useMemo(
    () => flattenCostBasis(positionResponse),
    [positionResponse]
  )

  const sortedPositionHistory = useMemo(() => {
    const numericKeys = new Set([
      'total_quantity_acquired',
      'total_quantity_sold',
      'remaining_quantity',
      'remaining_cost_basis',
      'realized_gain_loss',
    ])

    return [...positionHistory].sort((left, right) => {
      const leftValue = left[sortConfig.key] ?? ''
      const rightValue = right[sortConfig.key] ?? ''

      let comparison = 0

      if (numericKeys.has(sortConfig.key)) {
        comparison =
          Number(leftValue) - Number(rightValue)
      } else {
        comparison = String(leftValue).localeCompare(
          String(rightValue)
        )
      }

      return sortConfig.direction === 'asc'
        ? comparison
        : -comparison
    })
  }, [positionHistory, sortConfig])

  const accountActivity = useMemo(
    () => normalizeActivity(activityResponse),
    [activityResponse]
  )

  const dividendSummary = useMemo(
    () => summarizeDividends(dividendResponse),
    [dividendResponse]
  )


  // ---------------- Summary cards ----------------

  const remainingCostBasis = accountPositions.reduce(
    (total, position) =>
      total + Number(position.remaining_cost_basis ?? 0),
    0
  )

  const totalPrincipal = Number(
    principalResponse.total_principal ?? 0
  )

  const realizedGainLoss = accountPositions.reduce(
    (total, position) =>
      total + Number(position.realized_gain_loss ?? 0),
    0
  )

  const openPositionCount = accountPositions.filter(
    (position) => position.status === 'Open'
  ).length


  // --- Actions ---

  // Clicking the same column flips direction; choosing a new one starts
  // ascending. Sorting never needs another API request.
  function handleSort(key) {
    setSortConfig((current) => {
      if (current.key === key) {
        return {
          key,
          direction:
            current.direction === 'asc'
              ? 'desc'
              : 'asc',
        }
      }

      return {
        key,
        direction: 'asc',
      }
    })
  }


  function resetFilters() {
    setAccountFilter(filterOptions.account?.[0] ?? '')
    setYearFilter(filterOptions.year?.[0] ?? null)
    setSymbolFilter('')
    setStatusFilter('all')
    setTransactionTypeFilter(
      filterOptions.transaction_type?.includes('trade')
        ? 'trade'
        : filterOptions.transaction_type?.[0] ?? ''
    )
    setTransactionSubtypeFilter('')
  }


  if (loadingFilters) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-muted/30">
        <p className="text-sm text-muted-foreground">
          Loading dashboard...
        </p>
      </main>
    )
  }


  // --- Render ---

  return (
    <main className="h-screen w-screen overflow-hidden bg-muted/30">
      <div className="grid h-full min-h-0 grid-rows-[auto_auto_1fr] gap-3 p-3">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Fidelity Tracker
            </h1>

            <p className="text-sm text-muted-foreground">
              Account {accountFilter} · {yearFilter}
              {loadingDashboard ? ' · Updating...' : ''}
            </p>
          </div>

          <Button
            variant="outline"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={loadingDashboard}
          >
            {loadingDashboard ? 'Refreshing...' : 'Refresh'}
          </Button>
        </header>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <section className="grid grid-cols-4 gap-3">
          <StatCard
            title="Remaining Cost Basis"
            value={`$${formatMoney(remainingCostBasis)}`}
            description={`${openPositionCount} open positions`}
          />

          <StatCard
            title="Total Principal"
            value={`${
              totalPrincipal >= 0 ? '$' : '-$'
            }${formatMoney(Math.abs(totalPrincipal))}`}
            description="External deposits minus external withdrawals"
          />

          <StatCard
            title="Realized Gain / Loss"
            value={`${realizedGainLoss >= 0 ? '+' : '-'}$${formatMoney(
              Math.abs(realizedGainLoss)
            )}`}
            description="All-time realized result"
          />

          <StatCard
            title={`${yearFilter} Dividends`}
            value={`$${formatMoney(dividendSummary.totalDividend)}`}
            description="Selected-year distributions"
          />
        </section>

        <section
          className="grid min-h-0 grid-cols-[220px_minmax(0,2fr)_minmax(260px,0.8fr)] gap-3"
        >
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-800 text-zinc-100 shadow-sm">
            <div className="shrink-0 border-b border-zinc-700 px-4 py-3">
              <h2 className="font-semibold text-white">
                Filters
              </h2>

              <p className="text-xs text-zinc-400">
                Refine portfolio data
              </p>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
              <div className="space-y-2">
                <label
                  htmlFor="account-filter"
                  className="text-sm font-medium text-zinc-200"
                >
                  Account
                </label>

                <select
                  id="account-filter"
                  value={accountFilter}
                  onChange={(event) => {
                    setAccountFilter(event.target.value)
                    setSymbolFilter('')
                    setStatusFilter('all')
                  }}
                  className="w-full rounded-md border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none hover:border-zinc-500 focus:border-zinc-400"
                >
                  {filterOptions.account.map((account) => (
                    <option key={account} value={account}>
                      {account}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="year-filter"
                  className="text-sm font-medium text-zinc-200"
                >
                  Year
                </label>

                <select
                  id="year-filter"
                  value={yearFilter ?? ''}
                  onChange={(event) =>
                    setYearFilter(Number(event.target.value))
                  }
                  className="w-full rounded-md border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none hover:border-zinc-500 focus:border-zinc-400"
                >
                  {filterOptions.year.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="symbol-filter"
                  className="text-sm font-medium text-zinc-200"
                >
                  Symbol
                </label>

                <select
                  id="symbol-filter"
                  value={symbolFilter}
                  onChange={(event) =>
                    setSymbolFilter(event.target.value)
                  }
                  className="w-full rounded-md border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none hover:border-zinc-500 focus:border-zinc-400"
                >
                  <option value="">All symbols</option>
                  {filterOptions.symbol.map((symbol) => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="status-filter"
                  className="text-sm font-medium text-zinc-200"
                >
                  Position Status
                </label>

                <select
                  id="status-filter"
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value)
                  }
                  className="w-full rounded-md border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none hover:border-zinc-500 focus:border-zinc-400"
                >
                  <option value="all">All positions</option>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                </select>
              </div>

              <div className="border-t border-zinc-700 pt-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-400">
                  Activity Filters
                </p>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label
                      htmlFor="transaction-type-filter"
                      className="text-sm font-medium text-zinc-200"
                    >
                      Transaction Type
                    </label>

                    <select
                      id="transaction-type-filter"
                      value={transactionTypeFilter}
                      onChange={(event) => {
                        setTransactionTypeFilter(event.target.value)
                        setTransactionSubtypeFilter('')
                      }}
                      className="w-full rounded-md border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none hover:border-zinc-500 focus:border-zinc-400"
                    >
                      <option value="">All types</option>
                      {filterOptions.transaction_type.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="transaction-subtype-filter"
                      className="text-sm font-medium text-zinc-200"
                    >
                      Transaction Subtype
                    </label>

                    <select
                      id="transaction-subtype-filter"
                      value={transactionSubtypeFilter}
                      onChange={(event) =>
                        setTransactionSubtypeFilter(event.target.value)
                      }
                      className="w-full rounded-md border border-zinc-600 bg-zinc-700 px-3 py-2 text-sm text-zinc-100 outline-none hover:border-zinc-500 focus:border-zinc-400"
                    >
                      <option value="">All subtypes</option>
                      {filterOptions.transaction_subtype.map((subtype) => (
                        <option key={subtype} value={subtype}>
                          {subtype}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="shrink-0 border-t border-zinc-700 p-3">
              <Button
                variant="outline"
                className="w-full border-zinc-600 bg-zinc-700 text-zinc-100 hover:bg-zinc-600 hover:text-white"
                onClick={resetFilters}
              >
                Reset Filters
              </Button>
            </div>
          </aside>

          <div className="grid min-h-0 min-w-0 grid-rows-[0.72fr_1.28fr] gap-3">
            <AccountActivity
              accountActivity={accountActivity}
              year={yearFilter}
              transactionType={transactionTypeFilter}
            />

            <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
              <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
                <div>
                  <h2 className="font-semibold">
                    Position History
                  </h2>

                  <p className="text-xs text-muted-foreground">
                    All-time activity for the selected account
                  </p>
                </div>

                <p className="text-xs text-muted-foreground">
                  {positionHistory.length} positions
                </p>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="sticky top-0 z-10 border-b bg-muted/95">
                    <tr>
                      <SortableHeader
                        label="Symbol"
                        sortKey="symbol"
                        sortConfig={sortConfig}
                        onSort={handleSort}
                        align="left"
                      />

                      <SortableHeader
                        label="Type"
                        sortKey="security_type"
                        sortConfig={sortConfig}
                        onSort={handleSort}
                        align="left"
                      />

                      <SortableHeader
                        label="Total Acquired"
                        sortKey="total_quantity_acquired"
                        sortConfig={sortConfig}
                        onSort={handleSort}
                      />

                      <SortableHeader
                        label="Total Sold"
                        sortKey="total_quantity_sold"
                        sortConfig={sortConfig}
                        onSort={handleSort}
                      />

                      <SortableHeader
                        label="Remaining"
                        sortKey="remaining_quantity"
                        sortConfig={sortConfig}
                        onSort={handleSort}
                      />

                      <SortableHeader
                        label="Cost Basis"
                        sortKey="remaining_cost_basis"
                        sortConfig={sortConfig}
                        onSort={handleSort}
                      />

                      <SortableHeader
                        label="Realized P/L"
                        sortKey="realized_gain_loss"
                        sortConfig={sortConfig}
                        onSort={handleSort}
                      />

                      <SortableHeader
                        label="Status"
                        sortKey="status"
                        sortConfig={sortConfig}
                        onSort={handleSort}
                      />
                    </tr>
                  </thead>

                  <tbody>
                    {sortedPositionHistory.map((position) => (
                      <tr
                        key={`${position.account}-${position.symbol}`}
                        className="border-b last:border-0 hover:bg-muted/30"
                      >
                        <td className="px-4 py-3">
                          <Link
                            to={`/stocks/${encodeURIComponent(position.symbol)}`}
                            className="font-medium hover:underline"
                          >
                            {position.symbol}
                          </Link>
                          <p className="mt-0.5 max-w-48 truncate text-[10px] text-muted-foreground">
                            {position.security_name ?? '—'}
                          </p>
                        </td>

                        <td className="px-4 py-3 text-muted-foreground">
                          {position.security_type ?? '—'}
                        </td>

                        <td className="px-4 py-3 text-right">
                          {formatQuantity(position.total_quantity_acquired)}
                        </td>

                        <td className="px-4 py-3 text-right">
                          {formatQuantity(position.total_quantity_sold)}
                        </td>

                        <td className="px-4 py-3 text-right">
                          {formatQuantity(position.remaining_quantity)}
                        </td>

                        <td className="px-4 py-3 text-right">
                          ${formatMoney(position.remaining_cost_basis)}
                        </td>

                        <td
                          className={`px-4 py-3 text-right font-medium ${
                            Number(position.realized_gain_loss) >= 0
                              ? 'text-green-600'
                              : 'text-red-600'
                          }`}
                        >
                          {Number(position.realized_gain_loss) >= 0
                            ? '+'
                            : '-'}
                          ${formatMoney(
                            Math.abs(
                              Number(position.realized_gain_loss)
                            )
                          )}
                        </td>

                        <td className="px-4 py-3 text-right">
                          <span
                            className={
                              position.status === 'Open'
                                ? 'rounded-full bg-zinc-900 px-2 py-1 text-[10px] font-medium text-white'
                                : 'rounded-full bg-zinc-200 px-2 py-1 text-[10px] font-medium text-zinc-600'
                            }
                          >
                            {position.status}
                          </span>
                        </td>
                      </tr>
                    ))}

                    {positionHistory.length === 0 && (
                      <tr>
                        <td
                          colSpan="8"
                          className="px-4 py-10 text-center text-muted-foreground"
                        >
                          No position history matches the selected filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div className="grid min-h-0 min-w-0 grid-rows-2 gap-3">
            <AllocationDonut positions={accountPositions} />

            <DividendHeatmap
              monthlyDividend={dividendSummary.monthlyDividend}
              totalDividends={dividendSummary.totalDividend}
              year={yearFilter}
            />
          </div>
        </section>
      </div>
    </main>
  )
}


export default DashboardPage
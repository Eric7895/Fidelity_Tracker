import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { getRequest } from '@/services/api'


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


function formatLabel(value) {
  if (!value) {
    return '—'
  }

  return value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}


function formatDate(dateString) {
  return new Date(
    `${dateString}T00:00:00`
  ).toLocaleDateString()
}


// --- Data Helpers ---

function flattenCostBasis(response) {
  return Object.entries(response ?? {}).flatMap(
    ([account, symbols]) =>
      Object.entries(symbols ?? {}).map(
        ([symbol, stats]) => ({
          account,
          symbol,
          ...stats,
        })
      )
  )
}


// --- Shared Components ---

function DetailCard({
  title,
  value,
  description,
  valueClassName = '',
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-zinc-500">
        {title}
      </p>

      <p
        className={`mt-1 truncate text-xl font-semibold text-zinc-950 ${valueClassName}`}
      >
        {value}
      </p>

      {description && (
        <p className="mt-1 truncate text-xs text-zinc-500">
          {description}
        </p>
      )}
    </div>
  )
}


function SortIcon({
  column,
  sortColumn,
  sortDirection,
}) {
  if (column !== sortColumn) {
    return (
      <ArrowUpDown className="size-3.5 text-zinc-400" />
    )
  }

  if (sortDirection === 'asc') {
    return (
      <ArrowUp className="size-3.5 text-blue-700" />
    )
  }

  return (
    <ArrowDown className="size-3.5 text-blue-700" />
  )
}


function SortableHeader({
  label,
  column,
  sortColumn,
  sortDirection,
  onSort,
  align = 'left',
}) {
  return (
    <th
      className={`px-4 py-2 font-medium ${
        align === 'right'
          ? 'text-right'
          : 'text-left'
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1.5 hover:text-blue-700 ${
          align === 'right'
            ? 'justify-end'
            : 'justify-start'
        }`}
      >
        {label}

        <SortIcon
          column={column}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
        />
      </button>
    </th>
  )
}


// --- Transaction Styling ---

function transactionBadge(subtype) {
  switch (subtype) {
    case 'bought':
      return 'bg-blue-100 text-blue-800'

    case 'sold':
      return 'bg-rose-100 text-rose-800'

    case 'reinvestment':
      return 'bg-violet-100 text-violet-800'

    case 'ordinary_dividend':
      return 'bg-emerald-100 text-emerald-800'

    case 'long_term_cap_gain':
      return 'bg-teal-100 text-teal-800'

    case 'electronic_funds_transfer':
      return 'bg-amber-100 text-amber-800'

    case 'internal_account_transfer':
      return 'bg-zinc-200 text-zinc-700'

    default:
      return 'bg-zinc-100 text-zinc-700'
  }
}


// --- Stock Details ---

function StockDetailsPage() {
  const { symbol: symbolParam } = useParams()

  const symbol = decodeURIComponent(
    symbolParam ?? ''
  )


  // --- API State ---

  const [
    costBasisResponse,
    setCostBasisResponse,
  ] = useState({})

  const [
    activityResponse,
    setActivityResponse,
  ] = useState([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')


  // --- Table State ---

  const [sortColumn, setSortColumn] =
    useState('run_date')

  const [sortDirection, setSortDirection] =
    useState('desc')


  // --- Load Stock Data ---

  useEffect(() => {
    let cancelled = false

    async function loadStockDetails() {
      try {
        setLoading(true)
        setError('')

        /*
         * Cost basis gives us the position-level statistics.
         * Activity gives us the original transaction history.
         *
         * We intentionally do not filter by account here because the
         * same security may have existed in more than one Fidelity
         * account.
         */
        const [
          costBasis,
          activity,
        ] = await Promise.all([
          getRequest('/cost_basis', {
            symbol,
          }),

          getRequest('/activity', {
            symbol,
          }),
        ])

        if (cancelled) {
          return
        }

        setCostBasisResponse(costBasis)
        setActivityResponse(activity)
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError.message)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    if (symbol) {
      loadStockDetails()
    }

    return () => {
      cancelled = true
    }
  }, [symbol])


  // --- Derived Position Data ---

  const positions = useMemo(
    () => flattenCostBasis(costBasisResponse),
    [costBasisResponse]
  )


  const securityName =
    positions.find(
      (position) => position.security_name
    )?.security_name ?? symbol


  const securityType =
    positions.find(
      (position) => position.security_type
    )?.security_type ?? null


  const realizedGainLoss = positions.reduce(
    (total, position) =>
      total +
      Number(
        position.realized_gain_loss ?? 0
      ),
    0
  )


  const remainingQuantity = positions.reduce(
    (total, position) =>
      total +
      Number(
        position.remaining_quantity ?? 0
      ),
    0
  )


  const remainingCostBasis = positions.reduce(
    (total, position) =>
      total +
      Number(
        position.remaining_cost_basis ?? 0
      ),
    0
  )


  const totalAcquired = positions.reduce(
    (total, position) =>
      total +
      Number(
        position.total_quantity_acquired ?? 0
      ),
    0
  )


  const totalSold = positions.reduce(
    (total, position) =>
      total +
      Number(
        position.total_quantity_sold ?? 0
      ),
    0
  )


  // --- Transaction Sorting ---

  const sortedTransactions = useMemo(() => {
    const transactions = [
      ...activityResponse,
    ]

    transactions.sort((a, b) => {
      let first
      let second

      switch (sortColumn) {
        case 'run_date':
          first = new Date(a.run_date)
          second = new Date(b.run_date)
          break

        case 'amount':
          first = Number(a.amount ?? 0)
          second = Number(b.amount ?? 0)
          break

        default:
          first = String(
            a[sortColumn] ?? ''
          ).toLowerCase()

          second = String(
            b[sortColumn] ?? ''
          ).toLowerCase()
      }

      if (first < second) {
        return sortDirection === 'asc'
          ? -1
          : 1
      }

      if (first > second) {
        return sortDirection === 'asc'
          ? 1
          : -1
      }

      return 0
    })

    return transactions
  }, [
    activityResponse,
    sortColumn,
    sortDirection,
  ])


  // Clicking the same header reverses the order.
  // Clicking a new column starts ascending, except Date,
  // where newest-first is the more useful default.
  function handleSort(column) {
    if (column === sortColumn) {
      setSortDirection(
        sortDirection === 'asc'
          ? 'desc'
          : 'asc'
      )

      return
    }

    setSortColumn(column)

    setSortDirection(
      column === 'run_date'
        ? 'desc'
        : 'asc'
    )
  }


  // --- Loading State ---

  if (loading) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-blue-950">
        <div className="rounded-xl bg-white px-6 py-4 shadow-xl">
          <p className="text-sm text-zinc-500">
            Loading {symbol}...
          </p>
        </div>
      </main>
    )
  }


  // --- Error State ---

  if (error) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-blue-950 px-6">
        <div className="w-full max-w-md rounded-xl border bg-white p-6 text-center shadow-xl">
          <h1 className="text-lg font-semibold">
            Unable to load {symbol}
          </h1>

          <p className="mt-2 text-sm text-zinc-500">
            {error}
          </p>

          <Button
            className="mt-5"
            asChild
          >
            <Link to="/">
              Back to Dashboard
            </Link>
          </Button>
        </div>
      </main>
    )
  }


  // --- Render ---

  return (
    <main className="h-screen w-screen overflow-hidden bg-blue-950 p-3">

      <div className="grid h-full min-h-0 grid-rows-[auto_auto_1fr] gap-3 rounded-2xl bg-zinc-100 p-3 shadow-2xl">


        {/* --- Header --- */}

        <header className="rounded-xl bg-gradient-to-r from-blue-950 via-blue-900 to-blue-700 px-5 py-4 text-white shadow-sm">

          <Button
            variant="ghost"
            size="sm"
            asChild
            className="-ml-3 mb-2 text-blue-100 hover:bg-white/10 hover:text-white"
          >
            <Link
              to="/"
              className="inline-flex items-center gap-1"
            >
              <ChevronLeft className="size-4" />
              <span>Dashboard</span>
            </Link>
          </Button>


          <div className="flex items-end justify-between gap-4">

            <div className="min-w-0">

              <div className="flex items-center gap-3">

                <h1 className="text-3xl font-semibold tracking-tight">
                  {symbol}
                </h1>

                <span className="rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium text-blue-50">
                  {formatLabel(securityType)}
                </span>

              </div>


              <p className="mt-1 truncate text-sm text-blue-100">
                {securityName}
              </p>

            </div>


            <div className="text-right">

              <p className="text-xs text-blue-200">
                Recorded transactions
              </p>

              <p className="text-2xl font-semibold">
                {activityResponse.length}
              </p>

            </div>

          </div>

        </header>


        {/* --- Position Summary --- */}

        <section className="grid grid-cols-4 gap-3">

          <DetailCard
            title="Realized Gain / Loss"
            value={`${realizedGainLoss >= 0 ? '+' : '-'}$${formatMoney(
              Math.abs(realizedGainLoss)
            )}`}
            description="All-time realized result"
            valueClassName={
              realizedGainLoss >= 0
                ? '!text-emerald-600'
                : '!text-rose-600'
            }
          />


          <DetailCard
            title="Remaining Quantity"
            value={formatQuantity(
              remainingQuantity
            )}
            description={`${formatQuantity(
              totalAcquired
            )} acquired all-time`}
          />


          <DetailCard
            title="Remaining Cost Basis"
            value={`$${formatMoney(
              remainingCostBasis
            )}`}
            description="Basis attached to open shares"
          />


          <DetailCard
            title="Total Sold"
            value={formatQuantity(totalSold)}
            description={`${positions.length} account position${
              positions.length === 1
                ? ''
                : 's'
            }`}
          />

        </section>


        {/* --- Transaction History --- */}

        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-white shadow-sm">

          <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">

            <div>

              <h2 className="font-semibold">
                Transaction History
              </h2>

              <p className="text-xs text-zinc-500">
                All recorded Fidelity activity for {symbol}
              </p>

            </div>


            <p className="text-xs text-zinc-500">
              Click a column to sort
            </p>

          </div>


          <div className="min-h-0 flex-1 overflow-auto">

            <table className="w-full min-w-[800px] text-sm">

              <thead className="sticky top-0 z-10 border-b bg-zinc-100/95">

                <tr>

                  <SortableHeader
                    label="Date"
                    column="run_date"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />

                  <SortableHeader
                    label="Account"
                    column="account_number"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />

                  <SortableHeader
                    label="Type"
                    column="transaction_type"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />

                  <SortableHeader
                    label="Action"
                    column="transaction_subtype"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />

                  <SortableHeader
                    label="Amount"
                    column="amount"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align="right"
                  />

                </tr>

              </thead>


              <tbody>

                {sortedTransactions.map(
                  (transaction, index) => {

                    const amount = Number(
                      transaction.amount ?? 0
                    )

                    return (
                      <tr
                        key={`${transaction.run_date}-${transaction.account_number}-${index}`}
                        className="border-b last:border-0 hover:bg-blue-50/60"
                      >

                        <td className="whitespace-nowrap px-4 py-3">
                          {formatDate(
                            transaction.run_date
                          )}
                        </td>


                        <td className="px-4 py-3 text-zinc-500">
                          {transaction.account_number}
                        </td>


                        <td className="px-4 py-3">
                          {formatLabel(
                            transaction.transaction_type
                          )}
                        </td>


                        <td className="px-4 py-3">

                          <span
                            className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${transactionBadge(
                              transaction.transaction_subtype
                            )}`}
                          >
                            {formatLabel(
                              transaction.transaction_subtype
                            )}
                          </span>

                        </td>


                        <td
                          className={`px-4 py-3 text-right font-medium ${
                            amount > 0
                              ? 'text-emerald-600'
                              : amount < 0
                                ? 'text-rose-600'
                                : 'text-zinc-600'
                          }`}
                        >
                          {amount > 0
                            ? '+'
                            : amount < 0
                              ? '-'
                              : ''}

                          $

                          {formatMoney(
                            Math.abs(amount)
                          )}
                        </td>

                      </tr>
                    )
                  }
                )}


                {sortedTransactions.length ===
                  0 && (

                  <tr>

                    <td
                      colSpan="5"
                      className="px-4 py-12 text-center text-zinc-500"
                    >
                      No transactions found for {symbol}.
                    </td>

                  </tr>

                )}

              </tbody>

            </table>

          </div>

        </section>

      </div>

    </main>
  )
}


export default StockDetailsPage
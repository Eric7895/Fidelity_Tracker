import { Link } from 'react-router'
import { Button } from '@/components/ui/button'


function NotFoundPage() {
  return (
    <main className="flex h-screen w-screen items-center justify-center bg-muted/30 px-6">
      <div className="w-full max-w-lg text-center">

        <p className="text-sm font-medium text-muted-foreground">
          404
        </p>

        <h1 className="mt-3 text-4xl font-semibold tracking-tight">
          Page not found
        </h1>

        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or may have
          been moved.
        </p>

        <div className="mt-7 flex justify-center">
          <Button asChild>
            <Link to="/">
              Back to Dashboard
            </Link>
          </Button>
        </div>

      </div>
    </main>
  )
}


export default NotFoundPage
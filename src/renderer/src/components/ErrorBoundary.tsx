import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown in the fallback header so the user knows which area failed. */
  label?: string
  onReset?: () => void
}

interface State {
  error: Error | null
}

/** Catches render/lifecycle errors so a crash shows a recovery UI instead of a blank window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void window.engine?.logRendererError?.({
      message: error.message,
      stack:   error.stack ?? '',
      componentStack: info.componentStack ?? '',
      label:   this.props.label ?? 'app',
    })
  }

  private reset = (): void => {
    this.setState({ error: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="error-fallback" role="alert">
        <div className="error-fallback-icon">⚠️</div>
        <h2 className="error-fallback-title">Something went wrong</h2>
        <p className="error-fallback-desc">{error.message}</p>
        <button className="btn btn-primary" onClick={this.reset}>Return</button>
      </div>
    )
  }
}

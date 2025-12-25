import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signUp } from '@/lib/auth';
import { toast } from '@lome-chat/ui';

// Mock TanStack Router
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => vi.fn()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

// Mock auth client
vi.mock('@/lib/auth', () => ({
  signUp: {
    email: vi.fn(),
  },
}));

// Mock UI components
vi.mock('@lome-chat/ui', () => ({
  toast: {
    error: vi.fn(),
  },
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Mock AuthInput
vi.mock('@/components/auth/AuthInput', () => ({
  AuthInput: ({
    label,
    id,
    error,
    success,
    ...props
  }: {
    label: string;
    id?: string;
    error?: string;
    success?: string;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
      {error && <span role="alert">{error}</span>}
      {success && id && <span data-testid={`${id}-success`}>{success}</span>}
    </div>
  ),
}));

// Mock AuthPasswordInput
vi.mock('@/components/auth/AuthPasswordInput', () => ({
  AuthPasswordInput: ({
    label,
    id,
    error,
    success,
    ...props
  }: {
    label: string;
    id?: string;
    error?: string;
    success?: string;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input type="password" id={id} {...props} />
      {error && <span role="alert">{error}</span>}
      {success && id && <span data-testid={`${id}-success`}>{success}</span>}
    </div>
  ),
}));

// Mock AuthButton
vi.mock('@/components/auth/AuthButton', () => ({
  AuthButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

// Mock PasswordStrength
vi.mock('@/components/auth/PasswordStrength', () => ({
  PasswordStrength: () => <div data-testid="password-strength" />,
}));

describe('SignupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders signup form with all fields', async () => {
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  });

  it('renders login link', async () => {
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    expect(screen.getByRole('link', { name: /log in/i })).toHaveAttribute('href', '/login');
  });

  it('validates email format', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'invalid-email');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
  });

  it('validates password minimum length', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'short');
    await user.type(screen.getByLabelText(/confirm password/i), 'short');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
  });

  it('validates passwords match', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'different123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
    expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
  });

  it('calls signUp.email with valid data', async () => {
    vi.mocked(signUp.email).mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).toHaveBeenCalledWith({
      name: 'Test User',
      email: 'test@example.com',
      password: 'password123',
    });
  });

  it('shows success message on successful signup', async () => {
    vi.mocked(signUp.email).mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(screen.getByText(/check your email/i)).toBeInTheDocument();
  });

  it('shows error toast on signup failure', async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      data: null,
      error: { message: 'Email already exists' },
    });
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(toast.error).toHaveBeenCalledWith('Email already exists');
  });

  it('shows fallback error message when error has no message', async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      data: null,
      error: {},
    });
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(toast.error).toHaveBeenCalledWith('Signup failed');
  });

  it('shows success message when name is valid as user types', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/name/i), 'Test User');

    expect(screen.getByTestId('name-success')).toHaveTextContent('Looks good!');
  });

  it('shows success message when email is valid as user types', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');

    expect(screen.getByTestId('email-success')).toHaveTextContent('Valid email');
  });

  it('shows error message when email is invalid as user types', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), 'invalid');

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email');
  });

  it('shows success message when password meets requirements as user types', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');

    expect(screen.getByTestId('password-success')).toHaveTextContent('Password meets requirements');
  });

  it('shows error message when password is too short as user types', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/^password$/i), 'short');

    expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
  });

  it('shows success message when confirm password matches as user types', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');

    expect(screen.getByTestId('confirmPassword-success')).toHaveTextContent('Passwords match');
  });

  it('shows error message when confirm password does not match as user types', async () => {
    const user = userEvent.setup();
    const { SignupPage } = await import('./signup');

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'different');

    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('Passwords do not match');
  });
});

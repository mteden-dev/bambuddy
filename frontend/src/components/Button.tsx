import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...props
}: ButtonProps) {
  const baseStyles =
    'inline-flex items-center justify-center font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed';

  const variants = {
    primary: 'bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green',
    secondary:
      'bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray',
    danger: 'bg-red-600 hover:bg-red-700 text-white focus:ring-red-500',
    ghost:
      'bg-transparent hover:bg-bambu-dark-tertiary text-bambu-gray-light hover:text-white',
  };

  // Touch-sized unless the primary pointer is fine from md up; any coarse
  // pointer (an iPad, also with a keyboard case) keeps it at every width.
  const sizes = {
    sm: 'px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:pointer-fine:min-h-0 any-pointer-coarse:min-h-[44px]',
    md: 'px-4 py-2 text-sm gap-2 min-h-[44px] md:pointer-fine:min-h-0 any-pointer-coarse:min-h-[44px]',
    lg: 'px-6 py-3 text-base gap-2 min-h-[48px] md:pointer-fine:min-h-0 any-pointer-coarse:min-h-[48px]',
  };

  return (
    <button
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

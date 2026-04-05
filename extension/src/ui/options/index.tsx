import { type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

function OptionsPage(): ReactElement {
  return (
    <div>
      <h1>TopicBlock Options</h1>
      <p>Options UI — implemented in WP-2.</p>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<OptionsPage />);
}

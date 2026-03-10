import React from 'react';
import { X } from 'lucide-react';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
}

export default function Modal({ isOpen, onClose, title, children, footer }: ModalProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-[#1E293B] border border-white/10 rounded-xl shadow-2xl w-[90%] max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between bg-black/20">
                    <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
                    <button
                        onClick={onClose}
                        className="text-gray-500 hover:text-white transition-colors p-1 rounded-md hover:bg-white/10"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className="p-5">
                    {children}
                </div>

                {/* Footer */}
                {footer && (
                    <div className="px-5 py-3 border-t border-white/5 bg-black/20 flex items-center justify-end gap-2">
                        {footer}
                    </div>
                )}
            </div>
        </div>
    );
}

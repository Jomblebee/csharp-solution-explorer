using MediatR;
using TaskFlow.Application.Common.Interfaces;
using TaskFlow.Domain.Exceptions;

namespace TaskFlow.Application.Tasks.Commands.DeleteTask;

public class DeleteTaskCommandHandler(ITaskFlowDbContext db)
    : IRequestHandler<DeleteTaskCommand>
{
    public async Task Handle(DeleteTaskCommand request, CancellationToken cancellationToken)
    {
        var task = await db.Tasks.FindAsync([request.TaskId], cancellationToken)
            ?? throw new DomainException($"Task {request.TaskId} not found.");

        db.Tasks.Remove(task);
        await db.SaveChangesAsync(cancellationToken);
    }
}

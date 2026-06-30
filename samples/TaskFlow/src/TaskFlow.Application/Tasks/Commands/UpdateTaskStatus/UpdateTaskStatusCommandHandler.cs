using MediatR;
using TaskFlow.Application.Common.Interfaces;
using TaskFlow.Domain.Exceptions;

namespace TaskFlow.Application.Tasks.Commands.UpdateTaskStatus;

public class UpdateTaskStatusCommandHandler(ITaskFlowDbContext db)
    : IRequestHandler<UpdateTaskStatusCommand>
{
    public async Task Handle(UpdateTaskStatusCommand request, CancellationToken cancellationToken)
    {
        var task = await db.Tasks.FindAsync([request.TaskId], cancellationToken)
            ?? throw new DomainException($"Task {request.TaskId} not found.");

        task.Status = request.NewStatus;
        await db.SaveChangesAsync(cancellationToken);
    }
}
